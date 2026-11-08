import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { RateLimiter } from '../auth/rate-limit';
import { Actor, assertAdmin, audit } from '../common/access';
import { decrypt, encrypt, sha256 } from '../common/crypto';
import { Db, Tx } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';

export const WB_CATEGORIES = [
  'Acoso laboral o sexual',
  'Discriminación',
  'Fraude o corrupción',
  'Seguridad y salud laboral',
  'Protección de datos',
  'Incumplimiento de normativa laboral',
  'Medio ambiente',
  'Otro',
] as const;

const STATUS = ['received', 'acknowledged', 'investigating', 'resolved', 'dismissed'] as const;
export type WbStatus = (typeof STATUS)[number];

/** Código de seguimiento: 20 caracteres sin ambigüedades (≈100 bits). */
export function newTrackingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(20);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return chars.match(/.{1,5}/g)!.join('-');
}

const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
const codeHash = (code: string) => sha256(`wb:${normalizeCode(code)}`);

/**
 * Canal interno de información (Ley 2/2023): denuncias anónimas o identificadas, con código
 * de seguimiento, plazos legales y contenido cifrado. Solo lo gestiona quien tenga el rol
 * de Responsable del Sistema (compliance); ni administración ni RR. HH. lo ven por defecto.
 */
@Injectable()
export class WhistleblowingService {
  private readonly limiter = new RateLimiter(20, 15 * 60 * 1000);

  constructor(
    private readonly db: Db,
    private readonly notifications: NotificationsService,
  ) {}

  private assertHandler(actor: Actor) {
    if (!actor.isCompliance) throw new ForbiddenException('Solo la persona Responsable del Sistema interno de información accede a las denuncias');
  }

  // ── Configuración ──────────────────────────────────────────────────────────────────
  async settings(tx: Tx, actor: Actor) {
    if (!actor.isAdmin && !actor.isCompliance) throw new ForbiddenException();
    const t = await tx.one('SELECT whistleblowing_token FROM tenant WHERE id = $1', [tx.tenantId]);
    const handlers = await tx.query(
      `SELECT u.id, coalesce(p.first_name || ' ' || p.last_name, u.email) AS name FROM role_assignment r
         JOIN app_user u ON u.id = r.user_id LEFT JOIN person p ON p.id = u.person_id WHERE r.role = 'compliance'`,
    );
    return { enabled: Boolean(t.whistleblowing_token), token: t.whistleblowing_token, handlers };
  }

  async enable(tx: Tx, actor: Actor, regenerate = false) {
    assertAdmin(actor);
    const t = await tx.one('SELECT whistleblowing_token FROM tenant WHERE id = $1', [tx.tenantId]);
    if (t.whistleblowing_token && !regenerate) return { token: t.whistleblowing_token };
    const token = randomBytes(16).toString('base64url');
    await tx.query('UPDATE tenant SET whistleblowing_token = $2 WHERE id = $1', [tx.tenantId, token]);
    await audit(tx, 'whistleblowing.enabled', 'tenant', tx.tenantId, { regenerated: regenerate });
    return { token };
  }

  // ── Acceso público (sin sesión) ─────────────────────────────────────────────────────
  private async tenantFor(token: string, ip: string) {
    this.limiter.check(`wb:${ip}`);
    const [t] = await this.db.raw<{ tenant_id: string; tenant_name: string }>('SELECT * FROM wb_tenant_by_token($1)', [token]);
    if (!t) throw new NotFoundException('Canal no encontrado');
    return t;
  }

  async publicInfo(token: string, ip: string) {
    const t = await this.tenantFor(token, ip);
    return { organization: t.tenant_name, categories: WB_CATEGORIES };
  }

  async submit(token: string, ip: string, input: { category: string; subject: string; description: string; anonymous: boolean; contact?: string }) {
    const t = await this.tenantFor(token, ip);
    if (!input.anonymous && !input.contact) throw new BadRequestException('Indica cómo contactarte o marca la denuncia como anónima');
    const code = newTrackingCode();
    const now = Date.now();
    await this.db.tx(t.tenant_id, null, async (tx) => {
      const row = await tx.one(
        `INSERT INTO wb_report (tenant_id, code_hash, category, subject_enc, description_enc, anonymous, contact_enc, ack_due, resolution_due)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          tx.tenantId,
          codeHash(code),
          input.category,
          encrypt(input.subject),
          encrypt(input.description),
          input.anonymous,
          input.anonymous ? null : encrypt(input.contact!),
          new Date(now + 7 * 86400000),
          new Date(now + 90 * 86400000),
        ],
      );
      const handlers = (await tx.query(`SELECT user_id FROM role_assignment WHERE role = 'compliance'`)).map((r) => r.user_id);
      // El aviso no incluye el contenido.
      await this.notifications.notifyUsers(tx, handlers, {
        type: 'whistleblowing.received',
        title: 'Nueva comunicación en el canal de denuncias',
        body: 'Hay que acusar recibo en un máximo de 7 días (Ley 2/2023).',
        link: '/canal-denuncias',
      });
      // Auditoría sin contenido ni datos del informante.
      await tx.query(`INSERT INTO audit_event (tenant_id, actor_id, action, entity, entity_id) VALUES ($1, NULL, 'whistleblowing.received', 'wb_report', $2)`, [
        tx.tenantId,
        row.id,
      ]);
    });
    return { code };
  }

  private async reportByCode(tx: Tx, code: string) {
    const r = await tx.maybeOne('SELECT * FROM wb_report WHERE code_hash = $1', [codeHash(code)]);
    if (!r) throw new NotFoundException('Código no encontrado');
    return r;
  }

  private view(tx: Tx, r: any, messages: any[]) {
    return {
      id: r.id,
      category: r.category,
      subject: decrypt(r.subject_enc),
      description: decrypt(r.description_enc),
      anonymous: r.anonymous,
      contact: r.contact_enc ? decrypt(r.contact_enc) : null,
      status: r.status as WbStatus,
      receivedAt: r.received_at,
      ackDue: r.ack_due,
      resolutionDue: r.resolution_due,
      acknowledgedAt: r.acknowledged_at,
      resolvedAt: r.resolved_at,
      resolution: r.resolution_enc ? decrypt(r.resolution_enc) : null,
      messages: messages.map((m) => ({ author: m.author, body: decrypt(m.body_enc), createdAt: m.created_at })),
    };
  }

  async publicStatus(token: string, ip: string, code: string) {
    const t = await this.tenantFor(token, ip);
    return this.db.tx(t.tenant_id, null, async (tx) => {
      const r = await this.reportByCode(tx, code);
      const messages = await tx.query('SELECT author, body_enc, created_at FROM wb_message WHERE report_id = $1 ORDER BY created_at', [r.id]);
      const v = this.view(tx, r, messages);
      // El informante no necesita ver el identificador interno.
      return { ...v, id: undefined };
    });
  }

  async publicMessage(token: string, ip: string, code: string, body: string) {
    const t = await this.tenantFor(token, ip);
    return this.db.tx(t.tenant_id, null, async (tx) => {
      const r = await this.reportByCode(tx, code);
      if (['resolved', 'dismissed'].includes(r.status)) throw new BadRequestException('La comunicación está cerrada');
      await tx.query(`INSERT INTO wb_message (tenant_id, report_id, author, body_enc) VALUES ($1,$2,'reporter',$3)`, [tx.tenantId, r.id, encrypt(body)]);
      const handlers = (await tx.query(`SELECT user_id FROM role_assignment WHERE role = 'compliance'`)).map((x) => x.user_id);
      await this.notifications.notifyUsers(tx, handlers, { type: 'whistleblowing.message', title: 'Nuevo mensaje en una denuncia', link: '/canal-denuncias' });
      return { ok: true };
    });
  }

  // ── Gestión (Responsable del Sistema) ──────────────────────────────────────────────
  async list(tx: Tx, actor: Actor) {
    this.assertHandler(actor);
    const rows = await tx.query('SELECT * FROM wb_report ORDER BY (status IN (\'resolved\', \'dismissed\')), received_at DESC');
    return rows.map((r) => ({
      id: r.id,
      category: r.category,
      subject: decrypt(r.subject_enc),
      anonymous: r.anonymous,
      status: r.status,
      receivedAt: r.received_at,
      ackDue: r.ack_due,
      resolutionDue: r.resolution_due,
      overdue: (r.status === 'received' && new Date(r.ack_due) < new Date()) || (!['resolved', 'dismissed'].includes(r.status) && new Date(r.resolution_due) < new Date()),
    }));
  }

  async get(tx: Tx, actor: Actor, id: string) {
    this.assertHandler(actor);
    const r = await tx.maybeOne('SELECT * FROM wb_report WHERE id = $1', [id]);
    if (!r) throw new NotFoundException();
    const messages = await tx.query('SELECT author, body_enc, created_at FROM wb_message WHERE report_id = $1 ORDER BY created_at', [id]);
    await audit(tx, 'whistleblowing.viewed', 'wb_report', id);
    return this.view(tx, r, messages);
  }

  async reply(tx: Tx, actor: Actor, id: string, body: string) {
    this.assertHandler(actor);
    const r = await tx.maybeOne('SELECT status FROM wb_report WHERE id = $1 FOR UPDATE', [id]);
    if (!r) throw new NotFoundException();
    await tx.query(`INSERT INTO wb_message (tenant_id, report_id, author, handler_id, body_enc) VALUES ($1,$2,'handler',$3,$4)`, [tx.tenantId, id, actor.userId, encrypt(body)]);
    // Responder es también acusar recibo.
    await tx.query(`UPDATE wb_report SET status = 'acknowledged', acknowledged_at = now() WHERE id = $1 AND status = 'received'`, [id]);
    await audit(tx, 'whistleblowing.replied', 'wb_report', id);
    return { ok: true };
  }

  async setStatus(tx: Tx, actor: Actor, id: string, status: WbStatus, resolution?: string, extendResolution = false) {
    this.assertHandler(actor);
    const r = await tx.maybeOne('SELECT * FROM wb_report WHERE id = $1 FOR UPDATE', [id]);
    if (!r) throw new NotFoundException();
    if (['resolved', 'dismissed'].includes(status) && !resolution) throw new BadRequestException('Indica la resolución que verá el informante');
    await tx.query(
      `UPDATE wb_report SET status = $2,
              acknowledged_at = coalesce(acknowledged_at, CASE WHEN $2 <> 'received' THEN now() END),
              resolved_at = CASE WHEN $2 IN ('resolved', 'dismissed') THEN now() ELSE resolved_at END,
              resolution_enc = coalesce($3, resolution_enc),
              resolution_due = CASE WHEN $4 THEN received_at + interval '6 months' ELSE resolution_due END
        WHERE id = $1`,
      [id, status, resolution ? encrypt(resolution) : null, extendResolution],
    );
    await audit(tx, 'whistleblowing.status', 'wb_report', id, { status, extended: extendResolution });
    return { ok: true };
  }
}
