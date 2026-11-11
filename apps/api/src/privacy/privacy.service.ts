import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Actor, assertAdmin, audit, canHr, hrCompanyFilter, isHrAnywhere } from '../common/access';
import { addDays } from '../common/dates';
import { config } from '../config';
import { Db, Tx } from '../db/db.service';
import { StorageService } from '../documents/storage.service';
import { NotificationsService } from '../notifications/notifications.service';

export type RetentionCategory = 'time_entries' | 'notifications' | 'outbox' | 'audit' | 'former_employees';

/** Plazos por defecto (días). El registro de jornada no puede bajar de 4 años. */
export const DEFAULT_RETENTION: Record<RetentionCategory, number> = {
  time_entries: 4 * 365 + 1, // art. 34.9 ET
  former_employees: 4 * 365 + 1, // prescripción de obligaciones laborales y de Seguridad Social
  audit: 5 * 365,
  notifications: 365,
  outbox: 30,
};
export const MIN_RETENTION: Partial<Record<RetentionCategory, number>> = { time_entries: 4 * 365 + 1, former_employees: 4 * 365 + 1, audit: 365 };

export const KIND_LABEL: Record<string, string> = {
  access: 'Acceso',
  rectification: 'Rectificación',
  erasure: 'Supresión',
  restriction: 'Limitación del tratamiento',
  portability: 'Portabilidad',
  objection: 'Oposición',
};

@Injectable()
export class PrivacyService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Retención');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
  ) {}

  // Proceso automático diario (desactivable con OUTBOX_WORKER=false, igual que el de emails).
  onApplicationBootstrap() {
    if (!config.outboxWorker) return;
    this.timer = setInterval(() => void this.runAllTenants(), 24 * 3600 * 1000);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  private async runAllTenants() {
    const tenants = await this.db.raw<{ id: string }>('SELECT system_tenant_ids() AS id');
    for (const t of tenants) {
      try {
        await this.db.tx(t.id, null, (tx) => this.run(tx, false));
      } catch (err) {
        this.log.error(`Tenant ${t.id}: ${(err as Error).message}`);
      }
    }
    await this.db.raw('SELECT rate_limit_cleanup()').catch((err) => this.log.error(`Límites de intentos: ${(err as Error).message}`));
  }

  // ── Mis datos (acceso y portabilidad, arts. 15 y 20) ────────────────────────────────
  async myData(tx: Tx, actor: Actor) {
    if (!actor.personId) throw new BadRequestException('Tu cuenta no está asociada a una persona');
    const p = actor.personId;
    const ids = (await tx.query('SELECT id FROM employment WHERE person_id = $1', [p])).map((r) => r.id);
    const q = (sql: string, params: unknown[] = [p]) => tx.query(sql, params);
    const data = {
      generatedAt: new Date().toISOString(),
      note: 'Copia de tus datos personales en OpenHR (art. 15 y 20 del RGPD). Los ficheros de tus documentos se descargan desde «Documentos».',
      person: (await q('SELECT first_name, last_name, national_id, email, phone, birth_date, sex, custom_values, created_at FROM person WHERE id = $1'))[0],
      account: (await q('SELECT email, totp_enabled, last_login_at, created_at FROM app_user WHERE person_id = $1'))[0] ?? null,
      employments: await q(
        `SELECT e.id, c.name AS company, c.tax_id, e.job_title, e.professional_group, e.contract_type, e.start_date, e.end_date,
                e.weekly_minutes, e.schedule, e.vacation_days_per_year, e.custom_values
           FROM employment e JOIN company c ON c.id = e.company_id WHERE e.person_id = $1 ORDER BY e.start_date`,
      ),
      timeEntries: await q(
        `SELECT employment_id, kind, occurred_at, recorded_at, source, voids_entry_id, reason FROM time_entry WHERE employment_id = ANY($1) ORDER BY occurred_at`,
        [ids],
      ),
      shifts: await q('SELECT employment_id, date, is_day_off, start_at, end_at, break_minutes FROM shift_assignment WHERE employment_id = ANY($1) AND published_at IS NOT NULL ORDER BY date', [ids]),
      absences: await q(
        `SELECT r.employment_id, t.name AS type, r.start_date, r.end_date, r.days, r.status, r.comment, r.decision_comment, r.created_at
           FROM absence_request r JOIN absence_type t ON t.id = r.absence_type_id WHERE r.employment_id = ANY($1) ORDER BY r.start_date`,
        [ids],
      ),
      compensation: await q('SELECT employment_id, effective_from, base_annual, complements_annual, extra_salary_annual FROM compensation WHERE employment_id = ANY($1)', [ids]),
      documents: await q('SELECT title, category, period, published_at, first_read_at FROM document WHERE person_id = $1 ORDER BY published_at'),
      policyAcceptances: await q(
        'SELECT po.title, po.version, a.accepted_at, a.ip FROM policy_acceptance a JOIN policy po ON po.id = a.policy_id WHERE a.person_id = $1',
      ),
      signatures: await q('SELECT title, status, created_at, signed_at, evidence FROM signature_request WHERE person_id = $1'),
      privacyRequests: await q('SELECT kind, details, status, response, created_at, completed_at FROM privacy_request WHERE person_id = $1'),
    };
    await audit(tx, 'privacy.data_exported', 'person', p);
    return data;
  }

  // ── Solicitudes de derechos ─────────────────────────────────────────────────────────
  async request(tx: Tx, actor: Actor, input: { kind: string; details: string }) {
    if (!actor.personId) throw new BadRequestException('Tu cuenta no está asociada a una persona');
    const due = addDays(new Date().toISOString().slice(0, 10), 30);
    const row = await tx.one(
      `INSERT INTO privacy_request (tenant_id, person_id, user_id, kind, details, due_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [tx.tenantId, actor.personId, actor.userId, input.kind, input.details, due],
    );
    const handlers = (await tx.query(`SELECT DISTINCT user_id FROM role_assignment WHERE role = 'admin'`)).map((r) => r.user_id);
    await this.notifications.notifyUsers(tx, handlers, {
      type: 'privacy.request',
      title: `Nueva solicitud de ${KIND_LABEL[input.kind].toLowerCase()} de datos`,
      body: `Hay que responder antes del ${due} (art. 12.3 RGPD).`,
      link: '/privacidad',
    });
    await audit(tx, 'privacy.requested', 'privacy_request', row.id, { kind: input.kind });
    return { id: row.id, dueDate: due };
  }

  mine(tx: Tx, actor: Actor) {
    return tx.query('SELECT id, kind, details, status, due_date::text, response, created_at, completed_at FROM privacy_request WHERE person_id = $1 ORDER BY created_at DESC', [
      actor.personId,
    ]);
  }

  /** Administración ve todas; RR. HH., las de personas de sus sociedades. */
  list(tx: Tx, actor: Actor) {
    if (!isHrAnywhere(actor)) throw new ForbiddenException();
    const companies = actor.isAdmin ? null : hrCompanyFilter(actor);
    return tx.query(
      `SELECT r.id, r.kind, r.details, r.status, r.due_date::text, r.response, r.created_at, r.completed_at,
              p.first_name || ' ' || p.last_name AS person_name, r.person_id
         FROM privacy_request r JOIN person p ON p.id = r.person_id
        WHERE $1::uuid[] IS NULL OR EXISTS (SELECT 1 FROM employment e WHERE e.person_id = r.person_id AND e.company_id = ANY($1))
        ORDER BY (r.status IN ('received', 'in_progress')) DESC, r.due_date`,
      [companies],
    );
  }

  async respond(tx: Tx, actor: Actor, id: string, input: { status: 'in_progress' | 'completed' | 'rejected'; response?: string; extendDays?: number }) {
    const r = await tx.maybeOne('SELECT * FROM privacy_request WHERE id = $1 FOR UPDATE', [id]);
    if (!r) throw new NotFoundException();
    const companies = (await tx.query('SELECT company_id FROM employment WHERE person_id = $1', [r.person_id])).map((x) => x.company_id);
    if (!actor.isAdmin && !companies.some((c) => canHr(actor, c))) throw new ForbiddenException();
    if (['completed', 'rejected'].includes(input.status) && !input.response) throw new BadRequestException('Indica la respuesta a la persona');
    await tx.query(
      `UPDATE privacy_request SET status = $2, response = coalesce($3, response), handled_by = $4,
              due_date = due_date + $5::int, completed_at = CASE WHEN $2 IN ('completed', 'rejected') THEN now() END WHERE id = $1`,
      [id, input.status, input.response ?? null, actor.userId, Math.min(input.extendDays ?? 0, 60)],
    );
    if (r.user_id && ['completed', 'rejected'].includes(input.status)) {
      await this.notifications.notifyUsers(tx, [r.user_id], {
        type: 'privacy.answered',
        title: `Respuesta a tu solicitud de ${KIND_LABEL[r.kind].toLowerCase()}`,
        body: input.response,
        link: '/privacidad',
      });
    }
    await audit(tx, 'privacy.request_updated', 'privacy_request', id, { status: input.status });
    return { ok: true };
  }

  // ── Conservación ────────────────────────────────────────────────────────────────────
  async settings(tx: Tx) {
    const rows = await tx.query<{ category: RetentionCategory; days: number }>('SELECT category, days FROM retention_setting');
    const out = { ...DEFAULT_RETENTION };
    for (const r of rows) out[r.category] = r.days;
    return out;
  }

  async saveSettings(tx: Tx, actor: Actor, input: Partial<Record<RetentionCategory, number>>) {
    assertAdmin(actor);
    for (const [category, days] of Object.entries(input) as [RetentionCategory, number][]) {
      const min = MIN_RETENTION[category];
      if (min && days < min) throw new BadRequestException(`El plazo de ${category} no puede ser inferior a ${min} días`);
      await tx.query(
        `INSERT INTO retention_setting (tenant_id, category, days) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, category) DO UPDATE SET days = EXCLUDED.days`,
        [tx.tenantId, category, days],
      );
    }
    await audit(tx, 'retention.settings_saved', 'tenant', tx.tenantId, input);
    return this.settings(tx);
  }

  /** Aplica los plazos. Con dryRun solo cuenta lo que se borraría o anonimizaría. */
  async run(tx: Tx, dryRun: boolean, triggeredBy: string | null = null) {
    const s = await this.settings(tx);
    const cut = (days: number) => new Date(Date.now() - days * 86400000);
    const count = async (sql: string, params: unknown[]) => (await tx.one<{ n: number }>(sql, params)).n;
    const formerSql = `FROM person p WHERE p.anonymized_at IS NULL
        AND EXISTS (SELECT 1 FROM employment e WHERE e.person_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM employment e WHERE e.person_id = p.id AND (e.end_date IS NULL OR e.end_date >= $1::date))`;
    const formerCut = cut(s.former_employees).toISOString().slice(0, 10);
    const result = {
      timeEntries: await count('SELECT count(*)::int AS n FROM time_entry WHERE recorded_at < $1', [cut(s.time_entries)]),
      notifications: await count('SELECT count(*)::int AS n FROM notification WHERE created_at < $1', [cut(s.notifications)]),
      outbox: await count('SELECT count(*)::int AS n FROM outbox WHERE processed_at IS NOT NULL AND processed_at < $1', [cut(s.outbox)]),
      audit: await count('SELECT count(*)::int AS n FROM audit_event WHERE created_at < $1', [cut(s.audit)]),
      formerEmployees: await count(`SELECT count(*)::int AS n ${formerSql}`, [formerCut]),
    };
    if (dryRun) return { dryRun: true, settings: s, result };

    if (result.timeEntries) await tx.query('SELECT retention_purge_time_entries($1, $2)', [tx.tenantId, cut(s.time_entries)]);
    await tx.query('DELETE FROM notification WHERE created_at < $1', [cut(s.notifications)]);
    await tx.query('DELETE FROM outbox WHERE processed_at IS NOT NULL AND processed_at < $1', [cut(s.outbox)]);
    // audit_event es append-only para la app: solo se purga con su función dedicada.
    if (result.audit) await tx.query('SELECT retention_purge_audit($1, $2)', [tx.tenantId, cut(s.audit)]);
    const former = await tx.query<{ id: string }>(`SELECT p.id ${formerSql}`, [formerCut]);
    for (const { id } of former) await this.anonymize(tx, id);
    await tx.query(`INSERT INTO retention_run (tenant_id, triggered_by, result) VALUES ($1,$2,$3)`, [tx.tenantId, triggeredBy, JSON.stringify(result)]);
    await audit(tx, 'retention.run', 'tenant', tx.tenantId, result);
    return { dryRun: false, settings: s, result };
  }

  /** Anonimiza a una persona que ya no trabaja en el grupo y borra sus documentos. */
  async anonymize(tx: Tx, personId: string) {
    const docs = await tx.query<{ id: string; file_id: string }>('SELECT id, file_id FROM document WHERE person_id = $1', [personId]);
    await tx.query('UPDATE signature_request SET document_id = NULL WHERE document_id = ANY($1)', [docs.map((d) => d.id)]);
    await tx.query('DELETE FROM document WHERE person_id = $1', [personId]);
    for (const d of docs) {
      const stillUsed = await tx.maybeOne(
        'SELECT 1 FROM signature_request WHERE file_id = $1 OR signed_file_id = $1 UNION ALL SELECT 1 FROM policy WHERE file_id = $1 UNION ALL SELECT 1 FROM payslip_batch WHERE file_id = $1 LIMIT 1',
        [d.file_id],
      );
      if (!stillUsed) await this.storage.remove(tx, d.file_id);
    }
    await tx.query(
      `UPDATE person SET first_name = 'Persona', last_name = 'anonimizada', national_id = NULL, email = NULL, phone = NULL,
              birth_date = NULL, sex = NULL, custom_values = '{}', anonymized_at = now() WHERE id = $1`,
      [personId],
    );
    await tx.query(
      `UPDATE app_user SET email = 'anonimizada-' || id || '@invalid', password_hash = NULL, totp_secret = NULL, totp_enabled = false, is_active = false
        WHERE person_id = $1`,
      [personId],
    );
    await tx.query(`UPDATE signature_request SET evidence = '{"anonymized": true}', message = NULL WHERE person_id = $1`, [personId]);
    await tx.query('UPDATE employment SET custom_values = $2 WHERE person_id = $1', [personId, '{}']);
    await audit(tx, 'privacy.anonymized', 'person', personId);
  }

  async manualAnonymize(tx: Tx, actor: Actor, personId: string) {
    assertAdmin(actor);
    const active = await tx.maybeOne('SELECT 1 FROM employment WHERE person_id = $1 AND (end_date IS NULL OR end_date >= current_date)', [personId]);
    if (active) throw new BadRequestException('La persona aún tiene una relación laboral vigente');
    await this.anonymize(tx, personId);
    return { ok: true };
  }
}
