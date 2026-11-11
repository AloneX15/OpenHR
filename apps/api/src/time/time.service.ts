import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Actor, assertEmploymentAccess, assertHr, audit, hrCompanyFilter } from '../common/access';
import { expectedMinutes, loadCalendars } from '../common/calendar';
import { canonicalJson, sha256 } from '../common/crypto';
import { localDate, zonedToUtc } from '../common/dates';
import { config } from '../config';
import { Tx } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';
import { insideZone } from '../common/geo';
import { ENTRY_COLUMNS, entriesBetween } from './entries';
import { requestTimestamp } from './tsa';
import {
  chainHash,
  contentDigest,
  dailySummaries,
  EntryKind,
  entryContext,
  kindLabel,
  stateAfter,
  StoredEntry,
  TRANSITIONS,
  verifyChain,
  WorkState,
} from './worktime';

@Injectable()
export class TimeService {
  private readonly log = new Logger('Fichajes');

  constructor(private readonly notifications: NotificationsService) {}

  /** Inserta un evento en la cadena de la relación laboral (bloquea la fila de employment). */
  private async append(
    tx: Tx,
    employmentId: string,
    e: {
      kind: EntryKind;
      occurredAt: Date;
      source: 'clock' | 'manual' | 'import' | 'offline';
      voidsEntryId?: string | null;
      reason?: string | null;
      deviceTime?: Date | null;
      idempotencyKey?: string | null;
      channel?: 'web' | 'kiosk' | 'offline' | 'import';
      kioskDeviceId?: string | null;
      position?: { latitude: number; longitude: number; accuracyM: number | null; insideZone: boolean | null } | null;
    },
  ): Promise<StoredEntry> {
    const emp = await tx.one<{ time_chain_head: string | null; time_chain_seq: string }>(
      'SELECT time_chain_head, time_chain_seq FROM employment WHERE id = $1 FOR UPDATE',
      [employmentId],
    );
    const seq = Number(emp.time_chain_seq) + 1;
    const recordedAt = new Date();
    const createdBy = tx.userId!;
    const digest = contentDigest({
      employmentId,
      seq,
      kind: e.kind,
      occurredAt: e.occurredAt.toISOString(),
      recordedAt: recordedAt.toISOString(),
      source: e.source,
      voidsEntryId: e.voidsEntryId ?? null,
      reason: e.reason ?? null,
      createdBy,
      context: entryContext({
        channel: e.channel ?? null,
        kiosk_device_id: e.kioskDeviceId ?? null,
        latitude: e.position?.latitude ?? null,
        longitude: e.position?.longitude ?? null,
        accuracy_m: e.position?.accuracyM ?? null,
        inside_zone: e.position?.insideZone ?? null,
      }),
    });
    const hash = chainHash(emp.time_chain_head, digest);
    const row = await tx.one<StoredEntry>(
      `INSERT INTO time_entry (tenant_id, employment_id, seq, kind, occurred_at, recorded_at, device_time, source,
                               voids_entry_id, reason, created_by, idempotency_key, content_digest, prev_hash, hash,
                               channel, kiosk_device_id, latitude, longitude, accuracy_m, inside_zone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING ${ENTRY_COLUMNS}`,
      [
        tx.tenantId,
        employmentId,
        seq,
        e.kind,
        e.occurredAt,
        recordedAt,
        e.deviceTime ?? null,
        e.source,
        e.voidsEntryId ?? null,
        e.reason ?? null,
        createdBy,
        e.idempotencyKey ?? null,
        digest,
        emp.time_chain_head,
        hash,
        e.channel ?? null,
        e.kioskDeviceId ?? null,
        e.position?.latitude ?? null,
        e.position?.longitude ?? null,
        e.position?.accuracyM ?? null,
        e.position?.insideZone ?? null,
      ],
    );
    await tx.query('UPDATE employment SET time_chain_head = $2, time_chain_seq = $3 WHERE id = $1', [employmentId, hash, seq]);
    return row;
  }

  /**
   * Fichaje importado de otro sistema (source = 'import', con motivo). La clave de
   * idempotencia evita duplicarlo si la importación se repite. Devuelve null si ya existía.
   */
  async importEntry(tx: Tx, employmentId: string, e: { kind: Exclude<EntryKind, 'void'>; occurredAt: Date; reason: string; idempotencyKey: string }) {
    const existing = await tx.maybeOne('SELECT id FROM time_entry WHERE idempotency_key = $1', [e.idempotencyKey]);
    if (existing) return null;
    return this.append(tx, employmentId, { kind: e.kind, occurredAt: e.occurredAt, source: 'import', reason: e.reason, idempotencyKey: e.idempotencyKey, channel: 'import' });
  }

  /** Estado actual: se mira hacia atrás hasta 36 h para encontrar la última entrada abierta. */
  async currentState(tx: Tx, employmentId: string, now = new Date()): Promise<{ state: WorkState; since: Date | null }> {
    const from = new Date(now.getTime() - 36 * 3600 * 1000);
    const entries = await entriesBetween(tx, employmentId, from, new Date(now.getTime() + 60_000));
    const state = stateAfter(entries);
    const live = entries.filter((e) => e.kind !== 'void' && !entries.some((v) => v.voids_entry_id === e.id));
    const last = live[live.length - 1];
    return { state, since: state === 'out' ? null : (last?.occurred_at ?? null) };
  }

  private async ownActiveEmployment(actor: Actor, employmentId?: string): Promise<string> {
    const active = actor.employments.filter((e) => e.active);
    if (employmentId) {
      if (!active.some((e) => e.id === employmentId)) throw new ForbiddenException('Solo puedes fichar en tus propias relaciones laborales');
      return employmentId;
    }
    if (active.length === 0) throw new BadRequestException('No tienes ninguna relación laboral activa');
    if (active.length > 1) throw new BadRequestException('Tienes varias relaciones laborales: indica en cuál fichas');
    return active[0].id;
  }

  /** Fichaje en tiempo real. La hora válida es la del servidor. */
  async clock(
    tx: Tx,
    actor: Actor,
    input: {
      employmentId?: string;
      kind?: Exclude<EntryKind, 'void'>;
      idempotencyKey: string;
      deviceTime?: string;
      location?: { latitude: number; longitude: number; accuracy?: number };
      offlineAt?: string;
    },
  ) {
    const existing = await tx.maybeOne(`SELECT ${ENTRY_COLUMNS} FROM time_entry WHERE idempotency_key = $1`, [input.idempotencyKey]);
    if (existing) {
      if (!actor.employments.some((e) => e.id === existing.employment_id)) throw new ConflictException('Clave de idempotencia repetida');
      return { entry: existing, replayed: true };
    }
    const employmentId = await this.ownActiveEmployment(actor, input.employmentId);
    const emp = await tx.one('SELECT start_date::text, end_date::text FROM employment WHERE id = $1', [employmentId]);
    const today = new Date().toISOString().slice(0, 10);
    if (emp.start_date > today) throw new BadRequestException('Tu relación laboral aún no ha empezado');

    const position = await this.checkZone(tx, employmentId, input.location);

    // Fichaje hecho sin conexión y enviado después: vale la hora del dispositivo, acotada.
    if (input.offlineAt) {
      const at = new Date(input.offlineAt);
      const now = Date.now();
      if (isNaN(at.getTime()) || at.getTime() > now + 120_000) throw new BadRequestException('Hora del fichaje sin conexión no válida');
      if (at.getTime() < now - 72 * 3600_000) throw new BadRequestException('Los fichajes sin conexión deben enviarse en 72 horas; añádelo a mano con su motivo');
      if (!input.kind) throw new BadRequestException('Indica el tipo de fichaje');
      const entry = await this.append(tx, employmentId, {
        kind: input.kind,
        occurredAt: at,
        source: 'offline',
        reason: 'Fichaje sin conexión, enviado al recuperarla',
        deviceTime: at,
        idempotencyKey: input.idempotencyKey,
        channel: 'offline',
        position,
      });
      return { entry, replayed: false };
    }

    const { state } = await this.currentState(tx, employmentId);
    const kind = input.kind ?? (state === 'out' ? 'in' : 'out');
    if (!TRANSITIONS[state][kind]) {
      throw new ConflictException(`No puedes registrar «${kindLabel(kind)}» ahora (estado: ${stateLabel(state)})`);
    }
    const entry = await this.append(tx, employmentId, {
      kind,
      occurredAt: new Date(),
      source: 'clock',
      deviceTime: input.deviceTime ? new Date(input.deviceTime) : null,
      idempotencyKey: input.idempotencyKey,
      channel: 'web',
      position,
    });
    return { entry, replayed: false };
  }

  /**
   * Comprueba la zona de fichaje del centro. Con «registrar» guarda la posición; con
   * «exigir» rechaza fichar fuera (salvo personas con teletrabajo permitido). Con la zona
   * desactivada no se guarda ninguna posición.
   */
  async checkZone(tx: Tx, employmentId: string, location?: { latitude: number; longitude: number; accuracy?: number }) {
    const z = await tx.one(
      `SELECT wc.latitude, wc.longitude, wc.radius_m, coalesce(wc.geo_policy, 'off') AS policy, e.remote_allowed
         FROM employment e LEFT JOIN work_center wc ON wc.id = e.work_center_id WHERE e.id = $1`,
      [employmentId],
    );
    if (z.policy === 'off' || z.latitude === null || z.radius_m === null) return null;
    if (!location) {
      if (z.policy === 'require' && !z.remote_allowed) throw new ForbiddenException('Tu centro exige fichar con la ubicación activada');
      return null;
    }
    const inside = insideZone({ lat: z.latitude, lng: z.longitude, radius: z.radius_m }, { lat: location.latitude, lng: location.longitude, accuracy: location.accuracy });
    if (!inside && z.policy === 'require' && !z.remote_allowed) throw new ForbiddenException('Estás fuera de la zona de fichaje de tu centro');
    return { latitude: location.latitude, longitude: location.longitude, accuracyM: location.accuracy ?? null, insideZone: inside };
  }

  /** Fichaje desde un kiosco: la persona ya se ha identificado (PIN o QR). */
  async kioskClock(tx: Tx, employmentId: string, deviceId: string, idempotencyKey: string) {
    const existing = await tx.maybeOne(`SELECT ${ENTRY_COLUMNS} FROM time_entry WHERE idempotency_key = $1`, [idempotencyKey]);
    if (existing) return existing as StoredEntry;
    const { state } = await this.currentState(tx, employmentId);
    // En el kiosco se alterna: entrada si está fuera y salida en otro caso.
    const kind = state === 'out' ? 'in' : 'out';
    return this.append(tx, employmentId, { kind, occurredAt: new Date(), source: 'clock', idempotencyKey, channel: 'kiosk', kioskDeviceId: deviceId });
  }

  /** Fichaje olvidado o corrección: queda marcado como manual, con motivo y autor. */
  async addManual(
    tx: Tx,
    actor: Actor,
    input: { employmentId: string; kind: Exclude<EntryKind, 'void'>; date: string; time: string; reason: string },
  ) {
    const access = await assertEmploymentAccess(tx, actor, input.employmentId, ['self', 'hr']);
    const emp = await tx.one(
      `SELECT e.start_date::text, e.end_date::text, coalesce(wc.timezone, 'Europe/Madrid') AS tz
         FROM employment e LEFT JOIN work_center wc ON wc.id = e.work_center_id WHERE e.id = $1`,
      [input.employmentId],
    );
    const occurredAt = zonedToUtc(input.date, input.time, emp.tz);
    if (occurredAt.getTime() > Date.now() + 60_000) throw new BadRequestException('No se pueden registrar fichajes futuros');
    if (input.date < emp.start_date || (emp.end_date && input.date > emp.end_date)) {
      throw new BadRequestException('La fecha está fuera de la relación laboral');
    }
    const entry = await this.append(tx, input.employmentId, {
      kind: input.kind,
      occurredAt,
      source: 'manual',
      reason: input.reason,
    });
    if (access === 'self') await this.notifyCorrection(tx, input.employmentId, `Ha añadido un fichaje de ${kindLabel(input.kind)} el ${input.date} a las ${input.time}: ${input.reason}`);
    await audit(tx, 'time.manual_added', 'time_entry', entry.id, { employmentId: input.employmentId });
    return entry;
  }

  async voidEntry(tx: Tx, actor: Actor, entryId: string, reason: string) {
    const target = await tx.maybeOne(`SELECT ${ENTRY_COLUMNS} FROM time_entry WHERE id = $1`, [entryId]);
    if (!target) throw new NotFoundException('Fichaje no encontrado');
    if (target.kind === 'void') throw new BadRequestException('No se puede anular una anulación');
    const access = await assertEmploymentAccess(tx, actor, target.employment_id, ['self', 'hr']);
    const already = await tx.maybeOne('SELECT 1 FROM time_entry WHERE voids_entry_id = $1', [entryId]);
    if (already) throw new ConflictException('Ese fichaje ya está anulado');
    const entry = await this.append(tx, target.employment_id, {
      kind: 'void',
      occurredAt: new Date(),
      source: 'manual',
      voidsEntryId: entryId,
      reason,
    });
    if (access === 'self') await this.notifyCorrection(tx, target.employment_id, `Ha anulado un fichaje de ${kindLabel(target.kind)}: ${reason}`);
    await audit(tx, 'time.voided', 'time_entry', entryId, { reason });
    return entry;
  }

  private async notifyCorrection(tx: Tx, employmentId: string, text: string) {
    const managerId = await this.notifications.managerUserId(tx, employmentId);
    if (!managerId) return;
    const p = await tx.one(
      `SELECT p.first_name || ' ' || p.last_name AS name FROM employment e JOIN person p ON p.id = e.person_id WHERE e.id = $1`,
      [employmentId],
    );
    await this.notifications.notifyUsers(tx, [managerId], {
      type: 'time.correction',
      title: `${p.name} ha corregido su registro horario`,
      body: text,
      link: `/equipo/${employmentId}`,
      email: false,
    });
  }

  /** Fichajes y resumen diario (con jornada teórica) de un rango de fechas locales. */
  async range(tx: Tx, actor: Actor, employmentId: string, from: string, to: string) {
    await assertEmploymentAccess(tx, actor, employmentId);
    const cal = (await loadCalendars(tx, [employmentId], from, to)).get(employmentId);
    if (!cal) throw new NotFoundException();
    const start = zonedToUtc(from, '00:00', cal.timezone);
    const end = zonedToUtc(to, '23:59', cal.timezone);
    const endExclusive = new Date(end.getTime() + 60_000);
    const entries = await entriesBetween(tx, employmentId, start, endExclusive);
    const authors = await tx.query(
      `SELECT u.id, coalesce(p.first_name || ' ' || p.last_name, u.email) AS name FROM app_user u
         LEFT JOIN person p ON p.id = u.person_id WHERE u.id = ANY($1)`,
      [[...new Set(entries.map((e) => e.created_by))]],
    );
    const authorName = new Map(authors.map((a) => [a.id, a.name]));
    const voidedBy = new Map(entries.filter((e) => e.kind === 'void').map((e) => [e.voids_entry_id, e]));
    const days = dailySummaries(entries, cal.timezone, from, to).map((d) => ({
      ...d,
      expectedMinutes: expectedMinutes(cal, d.date),
      holiday: cal.holidays.get(d.date) ?? null,
      absence: cal.absences.get(d.date) ?? null,
      shift: cal.shifts?.get(d.date) ?? null,
    }));
    return {
      timezone: cal.timezone,
      days,
      entries: entries
        .filter((e) => e.kind !== 'void')
        .map((e) => ({
          id: e.id,
          kind: e.kind,
          occurredAt: e.occurred_at,
          localDate: localDate(e.occurred_at, cal.timezone),
          recordedAt: e.recorded_at,
          source: e.source,
          reason: e.reason,
          createdBy: authorName.get(e.created_by) ?? null,
          voided: voidedBy.has(e.id)
            ? { reason: voidedBy.get(e.id)!.reason, at: voidedBy.get(e.id)!.recorded_at, by: authorName.get(voidedBy.get(e.id)!.created_by) ?? null }
            : null,
        })),
    };
  }

  /** Quién está trabajando ahora (para responsables y RR. HH.). */
  async teamNow(tx: Tx, actor: Actor) {
    const companies = hrCompanyFilter(actor);
    const team = await tx.query(
      `SELECT e.id, p.first_name, p.last_name, c.name AS company_name
         FROM employment e JOIN person p ON p.id = e.person_id JOIN company c ON c.id = e.company_id
        WHERE (e.end_date IS NULL OR e.end_date >= current_date) AND e.start_date <= current_date
          AND (e.manager_employment_id = ANY($1) OR $2::uuid[] IS NULL OR e.company_id = ANY($2))
        ORDER BY p.last_name, p.first_name LIMIT 500`,
      [actor.employments.map((e) => e.id), companies],
    );
    const out = [];
    for (const m of team) {
      const { state, since } = await this.currentState(tx, m.id);
      out.push({ employmentId: m.id, name: `${m.first_name} ${m.last_name}`, companyName: m.company_name, state, since });
    }
    return out;
  }

  async verify(tx: Tx, actor: Actor, employmentId: string) {
    await assertEmploymentAccess(tx, actor, employmentId);
    const entries = await tx.query<StoredEntry>(`SELECT ${ENTRY_COLUMNS} FROM time_entry WHERE employment_id = $1 ORDER BY seq`, [employmentId]);
    const emp = await tx.one('SELECT time_chain_head, time_chain_seq FROM employment WHERE id = $1', [employmentId]);
    const cp = await tx.maybeOne('SELECT seq, hash FROM time_chain_checkpoint WHERE employment_id = $1', [employmentId]);
    const check = verifyChain(entries, cp ? { seq: Number(cp.seq), hash: cp.hash } : undefined);
    if (check.ok && (check.head !== emp.time_chain_head || check.count !== Number(emp.time_chain_seq))) {
      return { ok: false, problem: 'La cabeza de la cadena no coincide con el último fichaje (posible borrado)' };
    }
    return check;
  }

  /**
   * Sello de la sociedad: resume las cabezas de cadena de todas sus relaciones laborales
   * y lo envía por email a RR. HH. para que quede una copia fuera del sistema.
   */
  async seal(tx: Tx, actor: Actor, companyId: string) {
    assertHr(actor, companyId);
    return this.sealCompany(tx, companyId);
  }

  /**
   * Crea el sello sin comprobar permisos: lo usan `seal` (ya comprobados) y el sellado
   * automático, que pasa en `period` el mes cerrado. Si hay TSA configurada, la huella
   * lleva además un sello de tiempo RFC 3161; si la TSA falla, se sella igualmente sin él.
   * Devuelve null si otro proceso ya hizo el sello automático de ese mes.
   */
  async sealCompany(tx: Tx, companyId: string, period: string | null = null) {
    const rows = await tx.query(
      `SELECT id, time_chain_seq, time_chain_head FROM employment WHERE company_id = $1 AND time_chain_seq > 0 ORDER BY id`,
      [companyId],
    );
    const heads = Object.fromEntries(rows.map((r) => [r.id, { seq: Number(r.time_chain_seq), hash: r.time_chain_head }]));
    const digest = sha256(canonicalJson(heads));
    const company = await tx.one('SELECT name, tax_id FROM company WHERE id = $1', [companyId]);
    const recipients = await tx.query(
      `SELECT DISTINCT u.email FROM role_assignment r JOIN app_user u ON u.id = r.user_id
        WHERE u.is_active AND (r.role = 'admin' OR (r.role = 'hr' AND (r.company_id IS NULL OR r.company_id = $1)))`,
      [companyId],
    );
    let tsaResponse: Buffer | null = null;
    if (config.tsa.url) {
      try {
        tsaResponse = await requestTimestamp(config.tsa.url, digest);
      } catch (err) {
        this.log.warn(`Sello de tiempo no disponible (${config.tsa.url}): ${(err as Error).message}`);
      }
    }
    const seal = await tx.maybeOne(
      `INSERT INTO time_chain_seal (tenant_id, company_id, heads, digest, sent_to, automatic, period, tsa_response, tsa_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (company_id, period) WHERE automatic DO NOTHING
       RETURNING id, sealed_at, digest, automatic, period`,
      [tx.tenantId, companyId, JSON.stringify(heads), digest, recipients.map((r) => r.email), period !== null, period, tsaResponse, tsaResponse ? config.tsa.url : null],
    );
    if (!seal) return null;
    const what = period ? `Sello automático del mes ${period}` : 'Sello';
    const stamped = tsaResponse
      ? `\nSello de tiempo RFC 3161: emitido por ${config.tsa.url}. Se descarga desde Informes para verificarlo con la huella.`
      : '';
    for (const r of recipients) {
      await this.notifications.queueEmail(
        tx,
        r.email,
        `Sello del registro de jornada · ${company.name}`,
        `${what} del registro de jornada de ${company.name} (${company.tax_id}).\n\nFecha: ${new Date(seal.sealed_at).toISOString()}\nRelaciones laborales: ${rows.length}\nHuella SHA-256: ${digest}${stamped}\n\nConserva este correo: permite comprobar más adelante que los fichajes anteriores a esta fecha no se han modificado.`,
      );
    }
    await audit(tx, 'time.sealed', 'company', companyId, { digest, automatic: period !== null, period, timestamped: Boolean(tsaResponse) });
    return { ...seal, employments: rows.length, timestamped: Boolean(tsaResponse) };
  }

  /** Sellos de una sociedad, del más reciente al más antiguo. */
  async seals(tx: Tx, actor: Actor, companyId: string) {
    assertHr(actor, companyId);
    return tx.query(
      `SELECT id, sealed_at, digest, sent_to, automatic, period, tsa_response IS NOT NULL AS timestamped, tsa_url
         FROM time_chain_seal WHERE company_id = $1 ORDER BY sealed_at DESC LIMIT 50`,
      [companyId],
    );
  }

  /** Respuesta de la TSA de un sello (fichero .tsr), para verificarla fuera de OpenHR. */
  async sealTimestamp(tx: Tx, actor: Actor, sealId: string) {
    const s = await tx.maybeOne<{ company_id: string; digest: string; tsa_response: Buffer | null }>(
      'SELECT company_id, digest, tsa_response FROM time_chain_seal WHERE id = $1',
      [sealId],
    );
    if (!s) throw new NotFoundException('Sello no encontrado');
    assertHr(actor, s.company_id);
    if (!s.tsa_response) throw new NotFoundException('Este sello no tiene sello de tiempo');
    return { digest: s.digest, data: s.tsa_response };
  }
}

function stateLabel(state: WorkState) {
  return { out: 'fuera de jornada', working: 'trabajando', break: 'en pausa' }[state];
}
