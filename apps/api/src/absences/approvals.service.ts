import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Actor, assertAdmin, audit, canHr, hrCompanyFilter } from '../common/access';
import { Tx } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';

export type StepKind = 'manager' | 'manager_of_manager' | 'hr' | 'user' | 'admin';
export interface FlowStep {
  kind: StepKind;
  userId?: string;
}

export const DEFAULT_FLOW: FlowStep[] = [{ kind: 'manager' }];

export type DecidedAs = 'approver' | 'delegate' | 'hr';

const today = () => new Date().toISOString().slice(0, 10);

@Injectable()
export class ApprovalsService {
  constructor(private readonly notifications: NotificationsService) {}

  // ── Circuitos ───────────────────────────────────────────────────────────────────
  /** Circuito aplicable: el más específico (sociedad + tipo > sociedad > tipo > general). */
  async flowFor(tx: Tx, companyId: string, absenceTypeId: string, sensitive: boolean): Promise<FlowStep[]> {
    // Los datos de salud solo los aprueba RR. HH., sea cual sea el circuito.
    if (sensitive) return [{ kind: 'hr' }];
    const row = await tx.maybeOne<{ steps: FlowStep[] }>(
      `SELECT steps FROM approval_flow
        WHERE (company_id = $1 OR company_id IS NULL) AND (absence_type_id = $2 OR absence_type_id IS NULL)
        ORDER BY (company_id IS NOT NULL) DESC, (absence_type_id IS NOT NULL) DESC LIMIT 1`,
      [companyId, absenceTypeId],
    );
    return row?.steps ?? DEFAULT_FLOW;
  }

  listFlows(tx: Tx) {
    return tx.query(
      `SELECT f.id, f.company_id, c.name AS company_name, f.absence_type_id, t.name AS absence_type_name, f.steps, f.updated_at
         FROM approval_flow f LEFT JOIN company c ON c.id = f.company_id LEFT JOIN absence_type t ON t.id = f.absence_type_id
        ORDER BY c.name NULLS FIRST, t.name NULLS FIRST`,
    );
  }

  async saveFlow(tx: Tx, actor: Actor, input: { companyId: string | null; absenceTypeId: string | null; steps: FlowStep[] }) {
    if (input.companyId) {
      if (!canHr(actor, input.companyId)) throw new ForbiddenException();
    } else assertAdmin(actor);
    for (const s of input.steps) {
      if (s.kind === 'user') {
        const u = await tx.maybeOne('SELECT 1 FROM app_user WHERE id = $1 AND is_active', [s.userId]);
        if (!u) throw new BadRequestException('La persona aprobadora no existe o está desactivada');
      }
    }
    const row = await tx.one(
      `INSERT INTO approval_flow (tenant_id, company_id, absence_type_id, steps, updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, company_id, absence_type_id) DO UPDATE SET steps = EXCLUDED.steps, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING id`,
      [tx.tenantId, input.companyId, input.absenceTypeId, JSON.stringify(input.steps), tx.userId],
    );
    await audit(tx, 'approval_flow.saved', 'approval_flow', row.id, input);
    return row;
  }

  async deleteFlow(tx: Tx, actor: Actor, id: string) {
    const f = await tx.maybeOne('SELECT company_id FROM approval_flow WHERE id = $1', [id]);
    if (!f) throw new NotFoundException();
    if (f.company_id) {
      if (!canHr(actor, f.company_id)) throw new ForbiddenException();
    } else assertAdmin(actor);
    await tx.query('DELETE FROM approval_flow WHERE id = $1', [id]);
    await audit(tx, 'approval_flow.deleted', 'approval_flow', id);
    return { ok: true };
  }

  // ── Resolución de aprobadores ───────────────────────────────────────────────────
  async resolveApprovers(tx: Tx, step: FlowStep, employmentId: string, requesterUserId: string): Promise<string[]> {
    const emp = await tx.one('SELECT company_id, manager_employment_id FROM employment WHERE id = $1', [employmentId]);
    let ids: string[] = [];
    if (step.kind === 'manager' || step.kind === 'manager_of_manager') {
      let managerEmp: string | null = emp.manager_employment_id;
      if (step.kind === 'manager_of_manager' && managerEmp) {
        managerEmp = (await tx.maybeOne('SELECT manager_employment_id FROM employment WHERE id = $1', [managerEmp]))?.manager_employment_id ?? null;
      }
      if (managerEmp) {
        const u = await tx.maybeOne(
          `SELECT u.id FROM employment e JOIN app_user u ON u.person_id = e.person_id AND u.is_active WHERE e.id = $1`,
          [managerEmp],
        );
        if (u) ids = [u.id];
      }
    } else if (step.kind === 'hr') {
      ids = await this.notifications.hrUserIds(tx, emp.company_id);
    } else if (step.kind === 'admin') {
      ids = (await tx.query(`SELECT DISTINCT r.user_id FROM role_assignment r JOIN app_user u ON u.id = r.user_id AND u.is_active WHERE r.role = 'admin'`)).map(
        (r) => r.user_id,
      );
    } else if (step.kind === 'user' && step.userId) {
      const u = await tx.maybeOne('SELECT id FROM app_user WHERE id = $1 AND is_active', [step.userId]);
      if (u) ids = [u.id];
    }
    // Nadie aprueba lo suyo.
    return [...new Set(ids)].filter((id) => id !== requesterUserId);
  }

  /** Personas que tienen delegada la aprobación de alguno de estos usuarios hoy. */
  async delegatesOf(tx: Tx, userIds: string[]): Promise<string[]> {
    if (!userIds.length) return [];
    const rows = await tx.query(
      `SELECT DISTINCT d.to_user_id FROM approval_delegation d JOIN app_user u ON u.id = d.to_user_id AND u.is_active
        WHERE d.from_user_id = ANY($1) AND $2::date BETWEEN d.start_date AND d.end_date`,
      [userIds, today()],
    );
    return rows.map((r) => r.to_user_id);
  }

  // ── Ciclo de una solicitud ──────────────────────────────────────────────────────
  /** Crea los pasos de una solicitud y activa el primero. Devuelve si ya quedó aprobada. */
  async start(tx: Tx, requestId: string, employmentId: string, companyId: string, absenceTypeId: string, sensitive: boolean, requesterUserId: string) {
    const flow = await this.flowFor(tx, companyId, absenceTypeId, sensitive);
    for (let i = 0; i < flow.length; i++) {
      await tx.query(`INSERT INTO approval_step (tenant_id, request_id, step_index, kind, target_user_id) VALUES ($1,$2,$3,$4,$5)`, [
        tx.tenantId,
        requestId,
        i,
        flow[i].kind,
        flow[i].userId ?? null,
      ]);
    }
    return this.activateFrom(tx, requestId, 0, employmentId, requesterUserId);
  }

  /**
   * Activa el siguiente paso con aprobadores desde `index`; los que no tienen a nadie (p. ej.
   * sin responsable) se saltan. Si no queda ninguno, RR. HH. y, en último caso,
   * administración. Devuelve 'approved' si no hay nadie que deba aprobar.
   */
  async activateFrom(tx: Tx, requestId: string, index: number, employmentId: string, requesterUserId: string): Promise<'pending' | 'approved'> {
    const rows = await tx.query<{ kind: StepKind; target_user_id: string | null }>(
      'SELECT kind, target_user_id FROM approval_step WHERE request_id = $1 ORDER BY step_index',
      [requestId],
    );
    const flow: FlowStep[] = rows.map((r) => ({ kind: r.kind, userId: r.target_user_id ?? undefined }));
    for (let i = index; i < flow.length; i++) {
      const approvers = await this.resolveApprovers(tx, flow[i], employmentId, requesterUserId);
      if (!approvers.length) {
        await tx.query(`UPDATE approval_step SET status = 'skipped' WHERE request_id = $1 AND step_index = $2`, [requestId, i]);
        continue;
      }
      await tx.query(`UPDATE approval_step SET status = 'pending', approver_user_ids = $3 WHERE request_id = $1 AND step_index = $2`, [
        requestId,
        i,
        approvers,
      ]);
      await tx.query('UPDATE absence_request SET current_step = $2 WHERE id = $1', [requestId, i]);
      await this.notifyApprovers(tx, requestId, approvers);
      return 'pending';
    }
    // Nadie del circuito puede aprobar: si aún no se ha probado, RR. HH. o administración.
    const tried = await tx.query<{ kind: string }>('SELECT kind FROM approval_step WHERE request_id = $1', [requestId]);
    for (const kind of ['hr', 'admin'] as const) {
      if (tried.some((t) => t.kind === kind)) continue;
      const approvers = await this.resolveApprovers(tx, { kind }, employmentId, requesterUserId);
      if (!approvers.length) continue;
      const next = tried.length;
      await tx.query(
        `INSERT INTO approval_step (tenant_id, request_id, step_index, kind, status, approver_user_ids) VALUES ($1,$2,$3,$4,'pending',$5)`,
        [tx.tenantId, requestId, next, kind, approvers],
      );
      await tx.query('UPDATE absence_request SET current_step = $2 WHERE id = $1', [requestId, next]);
      await this.notifyApprovers(tx, requestId, approvers);
      return 'pending';
    }
    await tx.query(`UPDATE absence_request SET status = 'approved', decided_at = now(), current_step = NULL WHERE id = $1`, [requestId]);
    await audit(tx, 'absence.auto_approved', 'absence_request', requestId, { reason: 'Sin aprobadores disponibles' });
    return 'approved';
  }

  private async notifyApprovers(tx: Tx, requestId: string, approvers: string[]) {
    const r = await tx.one(
      `SELECT r.days, r.start_date::text, r.end_date::text, t.name AS type_name, t.sensitive, p.first_name || ' ' || p.last_name AS person
         FROM absence_request r JOIN absence_type t ON t.id = r.absence_type_id
         JOIN employment e ON e.id = r.employment_id JOIN person p ON p.id = e.person_id WHERE r.id = $1`,
      [requestId],
    );
    const range = r.start_date === r.end_date ? `el ${r.start_date}` : `del ${r.start_date} al ${r.end_date}`;
    const delegates = await this.delegatesOf(tx, approvers);
    await this.notifications.notifyUsers(tx, [...approvers, ...delegates], {
      type: 'absence.requested',
      title: `${r.person} solicita ${r.sensitive ? 'una ausencia' : r.type_name.toLowerCase()}`,
      body: `${r.person} ha solicitado ${Number(r.days)} día(s) ${range}. Necesita tu aprobación.`,
      link: '/ausencias?tab=aprobar',
    });
  }

  /** ¿Puede esta persona resolver el paso actual? Devuelve en calidad de qué, o null. */
  async canDecide(tx: Tx, actor: Actor, step: { approver_user_ids: string[] }, companyId: string): Promise<DecidedAs | null> {
    if (step.approver_user_ids.includes(actor.userId)) return 'approver';
    const delegates = await this.delegatesOf(tx, step.approver_user_ids);
    if (delegates.includes(actor.userId)) return 'delegate';
    if (canHr(actor, companyId)) return 'hr';
    return null;
  }

  /**
   * Resuelve el paso actual. Si se aprueba y quedan pasos, activa el siguiente.
   * Devuelve el estado final de la solicitud.
   */
  async decideStep(tx: Tx, actor: Actor, request: any, approve: boolean, comment?: string): Promise<'pending' | 'approved' | 'rejected'> {
    let step = await tx.maybeOne(
      `SELECT * FROM approval_step WHERE request_id = $1 AND status = 'pending' ORDER BY step_index LIMIT 1 FOR UPDATE`,
      [request.id],
    );
    if (!step) {
      // Solicitudes antiguas sin pasos: se crea uno con el circuito por defecto.
      step = await tx.one(
        `INSERT INTO approval_step (tenant_id, request_id, step_index, kind, status) VALUES ($1,$2,0,'manager','pending') RETURNING *`,
        [tx.tenantId, request.id],
      );
    }
    if (!step.approver_user_ids.length) {
      step.approver_user_ids = await this.resolveApprovers(
        tx,
        { kind: step.kind, userId: step.target_user_id ?? undefined },
        request.employment_id,
        request.requested_by,
      );
    }
    const as = await this.canDecide(tx, actor, step, request.company_id);
    if (!as) throw new ForbiddenException('Este paso de la aprobación no te corresponde');
    await tx.query(
      `UPDATE approval_step SET status = $2, decided_by = $3, decided_as = $4, decided_at = now(), comment = $5 WHERE id = $1`,
      [step.id, approve ? 'approved' : 'rejected', actor.userId, as, comment ?? null],
    );
    if (!approve) {
      await tx.query(`UPDATE approval_step SET status = 'cancelled' WHERE request_id = $1 AND status = 'waiting'`, [request.id]);
      return 'rejected';
    }
    // RR. HH. actuando como tal resuelve la solicitud entera.
    if (as === 'hr') {
      await tx.query(`UPDATE approval_step SET status = 'skipped' WHERE request_id = $1 AND status = 'waiting'`, [request.id]);
      return 'approved';
    }
    const remaining = await tx.maybeOne(`SELECT step_index FROM approval_step WHERE request_id = $1 AND status = 'waiting' ORDER BY step_index LIMIT 1`, [
      request.id,
    ]);
    if (!remaining) return 'approved';
    return this.activateFrom(tx, request.id, remaining.step_index, request.employment_id, request.requested_by);
  }

  /** IDs de solicitudes pendientes cuyo paso actual me toca (directamente o por delegación). */
  async pendingRequestIds(tx: Tx, actor: Actor): Promise<string[]> {
    const delegators = await tx.query(
      `SELECT DISTINCT from_user_id FROM approval_delegation WHERE to_user_id = $1 AND $2::date BETWEEN start_date AND end_date`,
      [actor.userId, today()],
    );
    const ids = [actor.userId, ...delegators.map((d) => d.from_user_id)];
    const companies = hrCompanyFilter(actor);
    const rows = await tx.query(
      `SELECT DISTINCT s.request_id FROM approval_step s
         JOIN absence_request r ON r.id = s.request_id JOIN employment e ON e.id = r.employment_id
        WHERE s.status = 'pending' AND r.status = 'pending' AND r.requested_by <> $3
          AND (s.approver_user_ids && $1::uuid[]
               OR ($2::uuid[] IS NULL OR e.company_id = ANY($2))
               OR (cardinality(s.approver_user_ids) = 0 AND e.manager_employment_id = ANY($4)))`,
      [ids, companies, actor.userId, actor.employments.map((e) => e.id)],
    );
    return rows.map((r) => r.request_id);
  }

  steps(tx: Tx, requestIds: string[]) {
    if (!requestIds.length) return Promise.resolve([]);
    return tx.query(
      `SELECT s.request_id, s.step_index, s.kind, s.status, s.decided_as, s.decided_at, s.comment,
              coalesce(p.first_name || ' ' || p.last_name, u.email) AS decided_by_name,
              (SELECT array_agg(coalesce(ap.first_name || ' ' || ap.last_name, au.email))
                 FROM app_user au LEFT JOIN person ap ON ap.id = au.person_id WHERE au.id = ANY(s.approver_user_ids)) AS approver_names
         FROM approval_step s LEFT JOIN app_user u ON u.id = s.decided_by LEFT JOIN person p ON p.id = u.person_id
        WHERE s.request_id = ANY($1) ORDER BY s.request_id, s.step_index`,
      [requestIds],
    );
  }

  // ── Delegaciones ────────────────────────────────────────────────────────────────
  listDelegations(tx: Tx, actor: Actor) {
    return tx.query(
      `SELECT d.id, d.from_user_id, d.to_user_id, d.start_date::text, d.end_date::text, d.reason,
              coalesce(fp.first_name || ' ' || fp.last_name, fu.email) AS from_name,
              coalesce(tp.first_name || ' ' || tp.last_name, tu.email) AS to_name
         FROM approval_delegation d
         JOIN app_user fu ON fu.id = d.from_user_id LEFT JOIN person fp ON fp.id = fu.person_id
         JOIN app_user tu ON tu.id = d.to_user_id LEFT JOIN person tp ON tp.id = tu.person_id
        WHERE (d.from_user_id = $1 OR d.to_user_id = $1 OR $2) AND d.end_date >= current_date - 30
        ORDER BY d.start_date DESC`,
      [actor.userId, actor.isAdmin],
    );
  }

  async createDelegation(tx: Tx, actor: Actor, input: { toUserId: string; startDate: string; endDate: string; reason?: string; fromUserId?: string }) {
    const from = input.fromUserId && input.fromUserId !== actor.userId ? input.fromUserId : actor.userId;
    if (from !== actor.userId) assertAdmin(actor);
    if (from === input.toUserId) throw new BadRequestException('No puedes delegar en ti');
    if (input.endDate < input.startDate) throw new BadRequestException('La fecha de fin es anterior a la de inicio');
    const to = await tx.maybeOne('SELECT 1 FROM app_user WHERE id = $1 AND is_active', [input.toUserId]);
    if (!to) throw new BadRequestException('La persona elegida no tiene una cuenta activa');
    const row = await tx.one(
      `INSERT INTO approval_delegation (tenant_id, from_user_id, to_user_id, start_date, end_date, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [tx.tenantId, from, input.toUserId, input.startDate, input.endDate, input.reason ?? null, actor.userId],
    );
    await this.notifications.notifyUsers(tx, [input.toUserId], {
      type: 'approval.delegated',
      title: 'Te han delegado aprobaciones',
      body: `Del ${input.startDate} al ${input.endDate} podrás aprobar solicitudes en su nombre.`,
      link: '/ausencias?tab=aprobar',
    });
    await audit(tx, 'approval.delegated', 'approval_delegation', row.id, { ...input, fromUserId: from });
    return row;
  }

  async deleteDelegation(tx: Tx, actor: Actor, id: string) {
    const d = await tx.maybeOne('SELECT from_user_id FROM approval_delegation WHERE id = $1', [id]);
    if (!d) throw new NotFoundException();
    if (d.from_user_id !== actor.userId) assertAdmin(actor);
    await tx.query('DELETE FROM approval_delegation WHERE id = $1', [id]);
    await audit(tx, 'approval.delegation_removed', 'approval_delegation', id);
    return { ok: true };
  }

  /** Personas con cuenta activa a las que se puede delegar o nombrar aprobadoras. */
  candidates(tx: Tx) {
    return tx.query(
      `SELECT u.id, coalesce(p.first_name || ' ' || p.last_name, u.email) AS name
         FROM app_user u LEFT JOIN person p ON p.id = u.person_id WHERE u.is_active ORDER BY 2 LIMIT 1000`,
    );
  }
}
