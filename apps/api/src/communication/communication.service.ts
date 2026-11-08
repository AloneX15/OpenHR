import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Actor, assertHr, audit, canHr, hrCompanyFilter, isHrAnywhere } from '../common/access';
import { Tx } from '../db/db.service';
import { StorageService } from '../documents/storage.service';
import { NotificationsService } from '../notifications/notifications.service';

/** Sociedades de las relaciones laborales vigentes de la persona usuaria. */
const myCompanies = (actor: Actor) => [...new Set(actor.employments.filter((e) => e.active).map((e) => e.companyId))];

function assertCanPublish(actor: Actor, companyId: string | null) {
  if (companyId) assertHr(actor, companyId);
  else if (!actor.isAdmin && !actor.hrAll) throw new ForbiddenException('Solo administración o RR. HH. del grupo publican para todo el grupo');
}

@Injectable()
export class CommunicationService {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
  ) {}

  /** Usuarios activos con relación laboral vigente en el alcance (una sociedad o todas). */
  private async audienceUserIds(tx: Tx, companyId: string | null): Promise<string[]> {
    const rows = await tx.query(
      `SELECT DISTINCT u.id FROM employment e JOIN app_user u ON u.person_id = e.person_id AND u.is_active
        WHERE (e.end_date IS NULL OR e.end_date >= current_date) AND ($1::uuid IS NULL OR e.company_id = $1)`,
      [companyId],
    );
    return rows.map((r) => r.id);
  }

  // ── Anuncios ─────────────────────────────────────────────────────────────────────
  async announcements(tx: Tx, actor: Actor, includeArchived = false) {
    const companies = hrCompanyFilter(actor);
    return tx.query(
      `SELECT a.id, a.company_id, c.name AS company_name, a.title, a.body, a.pinned, a.published_at, a.expires_at::text, a.archived,
              coalesce(p.first_name || ' ' || p.last_name, u.email) AS author, (r.read_at IS NOT NULL) AS read,
              (SELECT count(*)::int FROM announcement_read x WHERE x.announcement_id = a.id) AS reads
         FROM announcement a LEFT JOIN company c ON c.id = a.company_id
         LEFT JOIN app_user u ON u.id = a.created_by LEFT JOIN person p ON p.id = u.person_id
         LEFT JOIN announcement_read r ON r.announcement_id = a.id AND r.user_id = $1
        WHERE (a.company_id IS NULL OR a.company_id = ANY($2) OR $3::uuid[] IS NULL OR a.company_id = ANY($3))
          AND ($4 OR (NOT a.archived AND (a.expires_at IS NULL OR a.expires_at >= current_date)))
        ORDER BY a.pinned DESC, a.published_at DESC LIMIT 100`,
      [actor.userId, myCompanies(actor), companies, includeArchived],
    );
  }

  async publishAnnouncement(tx: Tx, actor: Actor, input: { companyId: string | null; title: string; body: string; pinned: boolean; expiresAt?: string; notify: boolean }) {
    assertCanPublish(actor, input.companyId);
    const row = await tx.one(
      `INSERT INTO announcement (tenant_id, company_id, title, body, pinned, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [tx.tenantId, input.companyId, input.title, input.body, input.pinned, input.expiresAt ?? null, actor.userId],
    );
    await this.notifications.notifyUsers(tx, (await this.audienceUserIds(tx, input.companyId)).filter((id) => id !== actor.userId), {
      type: 'announcement.published',
      title: input.title,
      body: input.body.slice(0, 280),
      link: '/anuncios',
      email: input.notify,
    });
    await audit(tx, 'announcement.published', 'announcement', row.id, { companyId: input.companyId, title: input.title });
    return row;
  }

  async updateAnnouncement(tx: Tx, actor: Actor, id: string, input: { title?: string; body?: string; pinned?: boolean; archived?: boolean; expiresAt?: string | null }) {
    const a = await tx.maybeOne('SELECT company_id FROM announcement WHERE id = $1', [id]);
    if (!a) throw new NotFoundException();
    assertCanPublish(actor, a.company_id);
    await tx.query(
      `UPDATE announcement SET title = coalesce($2, title), body = coalesce($3, body), pinned = coalesce($4, pinned),
              archived = coalesce($5, archived), expires_at = CASE WHEN $6 THEN $7::date ELSE expires_at END WHERE id = $1`,
      [id, input.title ?? null, input.body ?? null, input.pinned ?? null, input.archived ?? null, input.expiresAt !== undefined, input.expiresAt ?? null],
    );
    return { ok: true };
  }

  async markRead(tx: Tx, actor: Actor, id: string) {
    await tx.query(
      `INSERT INTO announcement_read (tenant_id, announcement_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [tx.tenantId, id, actor.userId],
    );
    return { ok: true };
  }

  // ── Políticas ────────────────────────────────────────────────────────────────────
  async policies(tx: Tx, actor: Actor) {
    const companies = hrCompanyFilter(actor);
    return tx.query(
      `SELECT po.id, po.series_id, po.version, po.company_id, c.name AS company_name, po.title, po.description, po.requires_acceptance,
              po.status, po.published_at, f.filename, a.accepted_at
         FROM policy po JOIN stored_file f ON f.id = po.file_id LEFT JOIN company c ON c.id = po.company_id
         LEFT JOIN policy_acceptance a ON a.policy_id = po.id AND a.person_id = $1
        WHERE po.status = 'published'
          AND (po.company_id IS NULL OR po.company_id = ANY($2) OR $3::uuid[] IS NULL OR po.company_id = ANY($3))
        ORDER BY (a.accepted_at IS NULL AND po.requires_acceptance) DESC, po.published_at DESC`,
      [actor.personId, myCompanies(actor), companies],
    );
  }

  async publishPolicy(
    tx: Tx,
    actor: Actor,
    input: { companyId: string | null; title: string; description?: string; requiresAcceptance: boolean; seriesId?: string },
    file: { buffer: Buffer; originalname: string; mimetype: string },
  ) {
    let version = 1;
    let seriesId = input.seriesId ?? randomUUID();
    let companyId = input.companyId;
    if (input.seriesId) {
      // Nueva versión: misma serie y alcance; la anterior se archiva y hay que volver a aceptar.
      const last = await tx.maybeOne('SELECT version, company_id FROM policy WHERE series_id = $1 ORDER BY version DESC LIMIT 1', [input.seriesId]);
      if (!last) throw new NotFoundException('Política no encontrada');
      companyId = last.company_id;
      version = last.version + 1;
      seriesId = input.seriesId;
    }
    assertCanPublish(actor, companyId);
    if (file.buffer.subarray(0, 5).toString() !== '%PDF-') throw new BadRequestException('La política debe ser un PDF');
    const stored = await this.storage.store(tx, file.buffer, file.originalname, 'application/pdf');
    await tx.query(`UPDATE policy SET status = 'archived' WHERE series_id = $1 AND status = 'published'`, [seriesId]);
    const row = await tx.one(
      `INSERT INTO policy (tenant_id, company_id, series_id, version, title, description, file_id, requires_acceptance, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [tx.tenantId, companyId, seriesId, version, input.title, input.description ?? null, stored.id, input.requiresAcceptance, actor.userId],
    );
    await this.notifications.notifyUsers(tx, (await this.audienceUserIds(tx, companyId)).filter((id) => id !== actor.userId), {
      type: 'policy.published',
      title: version > 1 ? `Nueva versión: ${input.title}` : `Nueva política: ${input.title}`,
      body: input.requiresAcceptance ? 'Léela y acéptala en OpenHR.' : 'Puedes consultarla en OpenHR.',
      link: '/politicas',
    });
    await audit(tx, 'policy.published', 'policy', row.id, { title: input.title, version, companyId });
    return { id: row.id, version };
  }

  async policyFile(tx: Tx, actor: Actor, id: string) {
    const po = await tx.maybeOne('SELECT file_id, company_id FROM policy WHERE id = $1', [id]);
    if (!po) throw new NotFoundException();
    const allowed = !po.company_id || myCompanies(actor).includes(po.company_id) || canHr(actor, po.company_id);
    if (!allowed) throw new ForbiddenException();
    return this.storage.read(tx, po.file_id);
  }

  async accept(tx: Tx, actor: Actor, id: string, meta: { ip?: string; userAgent?: string }) {
    if (!actor.personId) throw new BadRequestException('Tu cuenta no está asociada a una persona');
    const po = await tx.maybeOne(`SELECT po.*, f.sha256 FROM policy po JOIN stored_file f ON f.id = po.file_id WHERE po.id = $1`, [id]);
    if (!po || po.status !== 'published') throw new NotFoundException('Política no encontrada');
    if (po.company_id && !myCompanies(actor).includes(po.company_id)) throw new ForbiddenException();
    await tx.query(
      `INSERT INTO policy_acceptance (tenant_id, policy_id, person_id, user_id, file_sha256, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [tx.tenantId, id, actor.personId, actor.userId, po.sha256, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null],
    );
    await audit(tx, 'policy.accepted', 'policy', id, { sha256: po.sha256 });
    return { ok: true };
  }

  /** Quién ha aceptado y quién falta, entre las personas con relación vigente en el alcance. */
  async acceptances(tx: Tx, actor: Actor, id: string) {
    const po = await tx.maybeOne('SELECT company_id FROM policy WHERE id = $1', [id]);
    if (!po) throw new NotFoundException();
    if (po.company_id) assertHr(actor, po.company_id);
    else if (!isHrAnywhere(actor)) throw new ForbiddenException();
    const companies = hrCompanyFilter(actor);
    return tx.query(
      `SELECT DISTINCT ON (p.id) p.id AS person_id, p.first_name || ' ' || p.last_name AS name, c.name AS company_name, a.accepted_at
         FROM employment e JOIN person p ON p.id = e.person_id JOIN company c ON c.id = e.company_id
         LEFT JOIN policy_acceptance a ON a.policy_id = $1 AND a.person_id = p.id
        WHERE (e.end_date IS NULL OR e.end_date >= current_date) AND ($2::uuid IS NULL OR e.company_id = $2)
          AND ($3::uuid[] IS NULL OR e.company_id = ANY($3))
        ORDER BY p.id, a.accepted_at`,
      [id, po.company_id, companies],
    );
  }
}
