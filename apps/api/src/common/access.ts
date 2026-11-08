import { ForbiddenException } from '@nestjs/common';
import { Tx } from '../db/db.service';

export interface Actor {
  userId: string;
  tenantId: string;
  personId: string | null;
  isAdmin: boolean;
  /** Responsable del Sistema interno de información (canal de denuncias). */
  isCompliance: boolean;
  /** RR. HH. en todas las sociedades del tenant. */
  hrAll: boolean;
  hrCompanyIds: string[];
  /** Relaciones laborales vigentes o pasadas de la persona usuaria. */
  employments: { id: string; companyId: string; active: boolean }[];
}

export async function loadActor(tx: Tx): Promise<Actor> {
  if (!tx.userId) throw new ForbiddenException();
  const user = await tx.maybeOne<{ person_id: string | null; is_active: boolean }>(
    'SELECT person_id, is_active FROM app_user WHERE id = $1',
    [tx.userId],
  );
  if (!user || !user.is_active) throw new ForbiddenException('Usuario desactivado');
  const roles = await tx.query<{ role: string; company_id: string | null }>(
    'SELECT role, company_id FROM role_assignment WHERE user_id = $1',
    [tx.userId],
  );
  const employments = user.person_id
    ? await tx.query<{ id: string; company_id: string; active: boolean }>(
        `SELECT id, company_id, (end_date IS NULL OR end_date >= current_date) AS active
           FROM employment WHERE person_id = $1 ORDER BY start_date DESC`,
        [user.person_id],
      )
    : [];
  return {
    userId: tx.userId,
    tenantId: tx.tenantId,
    personId: user.person_id,
    isAdmin: roles.some((r) => r.role === 'admin'),
    isCompliance: roles.some((r) => r.role === 'compliance'),
    hrAll: roles.some((r) => r.role === 'hr' && r.company_id === null),
    hrCompanyIds: roles.filter((r) => r.role === 'hr' && r.company_id).map((r) => r.company_id!),
    employments: employments.map((e) => ({ id: e.id, companyId: e.company_id, active: e.active })),
  };
}

export function canHr(actor: Actor, companyId: string): boolean {
  return actor.isAdmin || actor.hrAll || actor.hrCompanyIds.includes(companyId);
}

export function isHrAnywhere(actor: Actor): boolean {
  return actor.isAdmin || actor.hrAll || actor.hrCompanyIds.length > 0;
}

export function assertHr(actor: Actor, companyId: string) {
  if (!canHr(actor, companyId)) throw new ForbiddenException('Necesitas permisos de RR. HH. en esta sociedad');
}

export function assertAdmin(actor: Actor) {
  if (!actor.isAdmin) throw new ForbiddenException('Necesitas permisos de administración');
}

/** Filtro SQL de sociedades visibles para RR. HH. (null = todas). */
export function hrCompanyFilter(actor: Actor): string[] | null {
  if (actor.isAdmin || actor.hrAll) return null;
  return actor.hrCompanyIds;
}

export type EmploymentAccess = 'self' | 'manager' | 'hr' | null;

/**
 * Qué relación tiene la persona usuaria con una relación laboral:
 * la suya, la de alguien a quien dirige (directamente) o una de una sociedad que gestiona.
 */
export async function employmentAccess(tx: Tx, actor: Actor, employmentId: string): Promise<EmploymentAccess> {
  const emp = await tx.maybeOne<{ company_id: string; person_id: string; manager_employment_id: string | null }>(
    'SELECT company_id, person_id, manager_employment_id FROM employment WHERE id = $1',
    [employmentId],
  );
  if (!emp) return null;
  if (emp.person_id === actor.personId) return 'self';
  if (canHr(actor, emp.company_id)) return 'hr';
  if (emp.manager_employment_id && actor.employments.some((e) => e.id === emp.manager_employment_id)) {
    return 'manager';
  }
  return null;
}

export async function assertEmploymentAccess(
  tx: Tx,
  actor: Actor,
  employmentId: string,
  allowed: EmploymentAccess[] = ['self', 'manager', 'hr'],
): Promise<EmploymentAccess> {
  const access = await employmentAccess(tx, actor, employmentId);
  if (!access || !allowed.includes(access)) throw new ForbiddenException('No tienes acceso a esta persona');
  return access;
}

export async function audit(tx: Tx, action: string, entity: string, entityId: string | null, data?: unknown) {
  await tx.query(
    'INSERT INTO audit_event (tenant_id, actor_id, action, entity, entity_id, data) VALUES ($1, $2, $3, $4, $5, $6)',
    [tx.tenantId, tx.userId, action, entity, entityId, data === undefined ? null : JSON.stringify(data)],
  );
}
