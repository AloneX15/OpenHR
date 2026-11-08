import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Actor, assertEmploymentAccess, assertHr, audit, hrCompanyFilter } from '../common/access';
import { expectedMinutes, loadCalendars } from '../common/calendar';
import { canonicalJson, sha256 } from '../common/crypto';
import { localDate, zonedToUtc } from '../common/dates';
import { Tx } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ENTRY_COLUMNS, entriesBetween } from './entries';
import {
  chainHash,
  contentDigest,
  dailySummaries,
  EntryKind,
  kindLabel,
  stateAfter,
  StoredEntry,
  TRANSITIONS,
  verifyChain,
  WorkState,
} from './worktime';

@Injectable()
export class TimeService {
  constructor(private readonly notifications: NotificationsService) {}

  /** Inserta un evento en la cadena de la relación laboral (bloquea la fila de employment). */
  private async append(
    tx: Tx,
    employmentId: string,
    e: {
      kind: EntryKind;
      occurredAt: Date;
      source: 'clock' | 'manual' | 'import';
      voidsEntryId?: string | null;
      reason?: string | null;
      deviceTime?: Date | null;
      idempotencyKey?: string | null;
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
    });
    const hash = chainHash(emp.time_chain_head, digest);
    const row = await tx.one<StoredEntry>(
      `INSERT INTO time_entry (tenant_id, employment_id, seq, kind, occurred_at, recorded_at, device_time, source,
                               voids_entry_id, reason, created_by, idempotency_key, content_digest, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING ${ENTRY_COLUMNS}`,
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
      ],
    );
    await tx.query('UPDATE employment SET time_chain_head = $2, time_chain_seq = $3 WHERE id = $1', [employmentId, hash, seq]);
    return row;
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
    input: { employmentId?: string; kind?: Exclude<EntryKind, 'void'>; idempotencyKey: string; deviceTime?: string },
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
    });
    return { entry, replayed: false };
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
    const check = verifyChain(entries);
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
    const seal = await tx.one(
      `INSERT INTO time_chain_seal (tenant_id, company_id, heads, digest, sent_to) VALUES ($1,$2,$3,$4,$5) RETURNING id, sealed_at, digest`,
      [tx.tenantId, companyId, JSON.stringify(heads), digest, recipients.map((r) => r.email)],
    );
    for (const r of recipients) {
      await this.notifications.queueEmail(
        tx,
        r.email,
        `Sello del registro de jornada · ${company.name}`,
        `Sello del registro de jornada de ${company.name} (${company.tax_id}).\n\nFecha: ${new Date(seal.sealed_at).toISOString()}\nRelaciones laborales: ${rows.length}\nHuella SHA-256: ${digest}\n\nConserva este correo: permite comprobar más adelante que los fichajes anteriores a esta fecha no se han modificado.`,
      );
    }
    await audit(tx, 'time.sealed', 'company', companyId, { digest });
    return { ...seal, employments: rows.length };
  }
}

function stateLabel(state: WorkState) {
  return { out: 'fuera de jornada', working: 'trabajando', break: 'en pausa' }[state];
}
