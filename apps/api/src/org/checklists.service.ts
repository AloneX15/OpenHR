import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Actor, assertEmploymentAccess, assertHr, audit, canHr, employmentAccess, hrCompanyFilter } from '../common/access';
import { addDays } from '../common/dates';
import { Tx } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';

export type ChecklistKind = 'onboarding' | 'offboarding' | 'transfer';
export type Assignee = 'hr' | 'manager' | 'employee';

export const KIND_LABEL: Record<ChecklistKind, string> = { onboarding: 'Alta', offboarding: 'Baja', transfer: 'Traspaso' };

export interface TemplateItemInput {
  title: string;
  description?: string;
  assignee: Assignee;
  dueOffsetDays: number;
}

@Injectable()
export class ChecklistsService {
  constructor(private readonly notifications: NotificationsService) {}

  // ── Plantillas ───────────────────────────────────────────────────────────────────
  async templates(tx: Tx) {
    const t = await tx.query(
      `SELECT t.id, t.company_id, c.name AS company_name, t.kind, t.name, t.active FROM checklist_template t
         LEFT JOIN company c ON c.id = t.company_id ORDER BY t.kind, c.name NULLS FIRST, t.name`,
    );
    const items = await tx.query(
      `SELECT id, template_id, position, title, description, assignee, due_offset_days FROM checklist_template_item ORDER BY template_id, position`,
    );
    return t.map((x) => ({ ...x, items: items.filter((i) => i.template_id === x.id) }));
  }

  async saveTemplate(
    tx: Tx,
    actor: Actor,
    id: string | null,
    input: { companyId: string | null; kind: ChecklistKind; name: string; active: boolean; items: TemplateItemInput[] },
  ) {
    if (input.companyId) assertHr(actor, input.companyId);
    else if (!actor.isAdmin && !actor.hrAll) throw new ForbiddenException('Solo administración o RR. HH. del grupo crean plantillas generales');
    let templateId = id;
    if (id) {
      const existing = await tx.maybeOne('SELECT company_id FROM checklist_template WHERE id = $1', [id]);
      if (!existing) throw new NotFoundException();
      if (existing.company_id && !canHr(actor, existing.company_id)) throw new ForbiddenException();
      await tx.query('UPDATE checklist_template SET company_id = $2, kind = $3, name = $4, active = $5 WHERE id = $1', [
        id,
        input.companyId,
        input.kind,
        input.name,
        input.active,
      ]);
      await tx.query('DELETE FROM checklist_template_item WHERE template_id = $1', [id]);
    } else {
      templateId = (
        await tx.one(`INSERT INTO checklist_template (tenant_id, company_id, kind, name, active) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
          tx.tenantId,
          input.companyId,
          input.kind,
          input.name,
          input.active,
        ])
      ).id;
    }
    for (const [i, item] of input.items.entries()) {
      await tx.query(
        `INSERT INTO checklist_template_item (tenant_id, template_id, position, title, description, assignee, due_offset_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [tx.tenantId, templateId, i, item.title, item.description ?? null, item.assignee, item.dueOffsetDays],
      );
    }
    await audit(tx, 'checklist_template.saved', 'checklist_template', templateId, { name: input.name, items: input.items.length });
    return { id: templateId };
  }

  /** Plantilla aplicable: la de la sociedad o, si no hay, la general. */
  private async templateFor(tx: Tx, companyId: string, kind: ChecklistKind) {
    return tx.maybeOne(
      `SELECT id, name FROM checklist_template WHERE kind = $2 AND active AND (company_id = $1 OR company_id IS NULL)
        ORDER BY (company_id IS NOT NULL) DESC, created_at LIMIT 1`,
      [companyId, kind],
    );
  }

  // ── Checklists de personas ──────────────────────────────────────────────────────
  /** Crea el checklist de alta, baja o traspaso a partir de la plantilla que aplique (si hay). */
  async startFor(tx: Tx, employmentId: string, kind: ChecklistKind, referenceDate: string, templateId?: string) {
    const emp = await tx.one('SELECT company_id FROM employment WHERE id = $1', [employmentId]);
    const template = templateId
      ? await tx.maybeOne('SELECT id, name FROM checklist_template WHERE id = $1', [templateId])
      : await this.templateFor(tx, emp.company_id, kind);
    if (!template) return null;
    const checklist = await tx.one(
      `INSERT INTO checklist (tenant_id, employment_id, kind, template_id, name, reference_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [tx.tenantId, employmentId, kind, template.id, template.name, referenceDate, tx.userId],
    );
    const items = await tx.query('SELECT * FROM checklist_template_item WHERE template_id = $1 ORDER BY position', [template.id]);
    for (const it of items) {
      await tx.query(
        `INSERT INTO checklist_task (tenant_id, checklist_id, position, title, description, assignee, due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [tx.tenantId, checklist.id, it.position, it.title, it.description, it.assignee, addDays(referenceDate, it.due_offset_days)],
      );
    }
    await this.notifyAssignees(tx, employmentId, checklist.id, kind);
    return checklist.id as string;
  }

  private async notifyAssignees(tx: Tx, employmentId: string, checklistId: string, kind: ChecklistKind) {
    const assignees = new Set(
      (await tx.query<{ assignee: Assignee }>('SELECT DISTINCT assignee FROM checklist_task WHERE checklist_id = $1', [checklistId])).map((r) => r.assignee),
    );
    const person = await tx.one(
      `SELECT p.first_name || ' ' || p.last_name AS name, e.company_id FROM employment e JOIN person p ON p.id = e.person_id WHERE e.id = $1`,
      [employmentId],
    );
    const users: string[] = [];
    if (assignees.has('hr')) users.push(...(await this.notifications.hrUserIds(tx, person.company_id)));
    if (assignees.has('manager')) {
      const m = await this.notifications.managerUserId(tx, employmentId);
      if (m) users.push(m);
    }
    if (assignees.has('employee')) {
      const u = await this.notifications.userIdForEmployment(tx, employmentId);
      if (u) users.push(u);
    }
    await this.notifications.notifyUsers(tx, users, {
      type: 'checklist.started',
      title: `Tareas de ${KIND_LABEL[kind].toLowerCase()}: ${person.name}`,
      body: 'Tienes tareas pendientes en el checklist.',
      link: '/tareas',
    });
  }

  async forEmployment(tx: Tx, actor: Actor, employmentId: string) {
    const access = await assertEmploymentAccess(tx, actor, employmentId);
    const lists = await tx.query(
      `SELECT id, kind, name, reference_date::text, status, created_at, completed_at FROM checklist WHERE employment_id = $1 ORDER BY created_at DESC`,
      [employmentId],
    );
    const tasks = await tx.query(
      `SELECT t.id, t.checklist_id, t.position, t.title, t.description, t.assignee, t.due_date::text, t.done_at, t.note,
              coalesce(p.first_name || ' ' || p.last_name, u.email) AS done_by_name
         FROM checklist_task t LEFT JOIN app_user u ON u.id = t.done_by LEFT JOIN person p ON p.id = u.person_id
        WHERE t.checklist_id = ANY($1) ORDER BY t.position`,
      [lists.map((l) => l.id)],
    );
    // La persona solo ve sus propias tareas.
    const visible = (t: any) => access === 'hr' || access === 'manager' || t.assignee === 'employee';
    return lists.map((l) => ({ ...l, tasks: tasks.filter((t) => t.checklist_id === l.id && visible(t)) }));
  }

  /** Tareas abiertas que me tocan: como RR. HH., como responsable o como la propia persona. */
  async myTasks(tx: Tx, actor: Actor) {
    const companies = hrCompanyFilter(actor);
    return tx.query(
      `SELECT t.id, t.title, t.description, t.assignee, t.due_date::text, c.id AS checklist_id, c.kind, c.name AS checklist_name,
              e.id AS employment_id, p.first_name || ' ' || p.last_name AS person_name, co.name AS company_name
         FROM checklist_task t JOIN checklist c ON c.id = t.checklist_id AND c.status = 'open'
         JOIN employment e ON e.id = c.employment_id JOIN person p ON p.id = e.person_id JOIN company co ON co.id = e.company_id
        WHERE t.done_at IS NULL AND (
          (t.assignee = 'hr' AND ($1::uuid[] IS NULL OR e.company_id = ANY($1)) AND ($1::uuid[] IS NULL OR cardinality($1) > 0))
          OR (t.assignee = 'manager' AND e.manager_employment_id = ANY($2))
          OR (t.assignee = 'employee' AND e.id = ANY($2)))
        ORDER BY t.due_date NULLS LAST, p.last_name
        LIMIT 500`,
      [companies, actor.employments.map((e) => e.id)],
    );
  }

  async setTask(tx: Tx, actor: Actor, taskId: string, done: boolean, note?: string) {
    const t = await tx.maybeOne(
      `SELECT t.*, c.employment_id, c.id AS cid FROM checklist_task t JOIN checklist c ON c.id = t.checklist_id WHERE t.id = $1 FOR UPDATE OF t`,
      [taskId],
    );
    if (!t) throw new NotFoundException('Tarea no encontrada');
    const access = await employmentAccess(tx, actor, t.employment_id);
    const allowed = access === 'hr' || (t.assignee === 'manager' && access === 'manager') || (t.assignee === 'employee' && access === 'self');
    if (!allowed) throw new ForbiddenException('Esta tarea no te corresponde');
    await tx.query('UPDATE checklist_task SET done_at = $2, done_by = $3, note = coalesce($4, note) WHERE id = $1', [
      taskId,
      done ? new Date() : null,
      done ? actor.userId : null,
      note ?? null,
    ]);
    const open = await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM checklist_task WHERE checklist_id = $1 AND done_at IS NULL', [t.cid]);
    await tx.query(
      `UPDATE checklist SET status = CASE WHEN $2 = 0 THEN 'done' ELSE 'open' END, completed_at = CASE WHEN $2 = 0 THEN now() END WHERE id = $1 AND status <> 'cancelled'`,
      [t.cid, open.n],
    );
    return { ok: true, checklistDone: open.n === 0 };
  }

  async startManually(tx: Tx, actor: Actor, employmentId: string, templateId: string, referenceDate: string) {
    const emp = await tx.maybeOne('SELECT company_id FROM employment WHERE id = $1', [employmentId]);
    if (!emp) throw new NotFoundException();
    assertHr(actor, emp.company_id);
    const tpl = await tx.maybeOne('SELECT kind, company_id FROM checklist_template WHERE id = $1', [templateId]);
    if (!tpl || (tpl.company_id && tpl.company_id !== emp.company_id)) throw new BadRequestException('Plantilla no válida para esta sociedad');
    const id = await this.startFor(tx, employmentId, tpl.kind, referenceDate, templateId);
    return { id };
  }
}
