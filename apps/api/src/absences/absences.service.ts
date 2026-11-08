import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Actor, assertEmploymentAccess, assertHr, audit, canHr, employmentAccess, hrCompanyFilter } from '../common/access';
import { EmploymentCalendar, isEmployed, isWorkingDay, loadCalendars } from '../common/calendar';
import { eachDay } from '../common/dates';
import { Tx } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ApprovalsService } from './approvals.service';

export function countAbsenceDays(cal: EmploymentCalendar, unit: 'working' | 'calendar', start: string, end: string): number {
  let n = 0;
  for (const d of eachDay(start, end)) {
    if (unit === 'calendar' ? isEmployed(cal, d) : isWorkingDay(cal, d)) n++;
  }
  return n;
}

/** Vacaciones del año prorrateadas por los días de alta, redondeadas a medio día. */
export function proratedAllowance(perYear: number, year: number, startDate: string, endDate: string | null): number {
  const yStart = `${year}-01-01`;
  const yEnd = `${year}-12-31`;
  const from = startDate > yStart ? startDate : yStart;
  const to = endDate && endDate < yEnd ? endDate : yEnd;
  if (from > to) return 0;
  const daysInYear = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
  const employed = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  return Math.round(((perYear * employed) / daysInYear) * 2) / 2;
}

const REQUEST_COLUMNS = `r.id, r.employment_id, r.absence_type_id, r.start_date::text, r.end_date::text, r.days, r.status,
  r.comment, r.decided_at, r.decision_comment, r.created_at, t.name AS type_name, t.code AS type_code,
  t.sensitive, t.counts_as_vacation, p.first_name || ' ' || p.last_name AS person_name, c.name AS company_name,
  e.company_id, dp.first_name || ' ' || dp.last_name AS decided_by_name`;
const REQUEST_FROM = `absence_request r
  JOIN absence_type t ON t.id = r.absence_type_id
  JOIN employment e ON e.id = r.employment_id
  JOIN person p ON p.id = e.person_id
  JOIN company c ON c.id = e.company_id
  LEFT JOIN app_user du ON du.id = r.decided_by
  LEFT JOIN person dp ON dp.id = du.person_id`;

@Injectable()
export class AbsencesService {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly approvals: ApprovalsService,
  ) {}

  async balance(tx: Tx, actor: Actor, employmentId: string, year: number) {
    await assertEmploymentAccess(tx, actor, employmentId);
    return this.computeBalance(tx, employmentId, year);
  }

  async computeBalance(tx: Tx, employmentId: string, year: number) {
    const emp = await tx.one(
      'SELECT vacation_days_per_year, start_date::text, end_date::text FROM employment WHERE id = $1',
      [employmentId],
    );
    const entitled = proratedAllowance(Number(emp.vacation_days_per_year), year, emp.start_date, emp.end_date);
    const adj = await tx.one<{ days: string }>(
      'SELECT coalesce(sum(days), 0) AS days FROM vacation_adjustment WHERE employment_id = $1 AND year = $2',
      [employmentId, year],
    );
    // Una solicitud que cruza el cambio de año cuenta en el año en que empieza.
    const used = await tx.query<{ status: string; days: string }>(
      `SELECT r.status, sum(r.days) AS days FROM absence_request r JOIN absence_type t ON t.id = r.absence_type_id
        WHERE r.employment_id = $1 AND t.counts_as_vacation AND extract(year FROM r.start_date) = $2
          AND r.status IN ('approved', 'pending')
        GROUP BY r.status`,
      [employmentId, year],
    );
    const approved = Number(used.find((u) => u.status === 'approved')?.days ?? 0);
    const pending = Number(used.find((u) => u.status === 'pending')?.days ?? 0);
    const adjustments = Number(adj.days);
    return {
      year,
      entitled,
      adjustments,
      approved,
      pending,
      available: entitled + adjustments - approved - pending,
    };
  }

  async request(
    tx: Tx,
    actor: Actor,
    input: { employmentId?: string; absenceTypeId: string; startDate: string; endDate: string; comment?: string },
  ) {
    const employmentId = input.employmentId ?? actor.employments.find((e) => e.active)?.id;
    if (!employmentId) throw new BadRequestException('No tienes ninguna relación laboral activa');
    const access = await assertEmploymentAccess(tx, actor, employmentId, ['self', 'hr']);
    if (input.endDate < input.startDate) throw new BadRequestException('La fecha de fin es anterior a la de inicio');

    const type = await tx.maybeOne('SELECT * FROM absence_type WHERE id = $1 AND active', [input.absenceTypeId]);
    if (!type) throw new BadRequestException('Tipo de ausencia no válido');
    const cal = (await loadCalendars(tx, [employmentId], input.startDate, input.endDate)).get(employmentId)!;
    if (!isEmployed(cal, input.startDate) || !isEmployed(cal, input.endDate)) {
      throw new BadRequestException('Las fechas están fuera de la relación laboral');
    }
    const days = countAbsenceDays(cal, type.day_unit, input.startDate, input.endDate);
    if (days === 0) throw new BadRequestException('El periodo no incluye ningún día laborable');

    const overlap = await tx.maybeOne(
      `SELECT 1 FROM absence_request WHERE employment_id = $1 AND status IN ('pending', 'approved')
          AND start_date <= $3 AND end_date >= $2`,
      [employmentId, input.startDate, input.endDate],
    );
    if (overlap) throw new ConflictException('Ya tienes una ausencia solicitada o aprobada en esas fechas');

    if (type.counts_as_vacation) {
      const bal = await this.computeBalance(tx, employmentId, Number(input.startDate.slice(0, 4)));
      if (days > bal.available && access === 'self') {
        throw new BadRequestException(`No tienes saldo suficiente: pides ${days} días y te quedan ${bal.available}`);
      }
    }

    // RR. HH. registra directamente aprobado; los tipos sin aprobación también.
    const autoApprove = !type.requires_approval || access === 'hr';
    const row = await tx.one(
      `INSERT INTO absence_request (tenant_id, employment_id, absence_type_id, start_date, end_date, days, status, comment,
                                    requested_by, decided_by, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        tx.tenantId,
        employmentId,
        type.id,
        input.startDate,
        input.endDate,
        days,
        autoApprove ? 'approved' : 'pending',
        input.comment ?? null,
        tx.userId,
        autoApprove ? tx.userId : null,
        autoApprove ? new Date() : null,
      ],
    );
    const person = await tx.one(
      `SELECT p.first_name || ' ' || p.last_name AS name, e.company_id FROM employment e JOIN person p ON p.id = e.person_id WHERE e.id = $1`,
      [employmentId],
    );
    const range = input.startDate === input.endDate ? `el ${input.startDate}` : `del ${input.startDate} al ${input.endDate}`;
    let status: 'pending' | 'approved' = autoApprove ? 'approved' : 'pending';
    if (!autoApprove) {
      // Circuito de aprobación (multinivel, con delegaciones): activa el primer paso y avisa.
      status = await this.approvals.start(tx, row.id, employmentId, person.company_id, type.id, type.sensitive, tx.userId!);
    } else if (type.sensitive && access === 'self') {
      await this.notifications.notifyUsers(tx, await this.notifications.hrUserIds(tx, person.company_id), {
        type: 'absence.reported',
        title: `${person.name} ha comunicado una ausencia`,
        body: `${type.name} ${range}.`,
        link: '/ausencias?tab=aprobar',
      });
    }
    await audit(tx, 'absence.requested', 'absence_request', row.id, { days, status });
    return { id: row.id, days, status };
  }

  async decide(tx: Tx, actor: Actor, requestId: string, approve: boolean, comment?: string) {
    const r = await tx.maybeOne(
      `SELECT r.*, t.sensitive, t.name AS type_name, e.company_id FROM absence_request r
         JOIN absence_type t ON t.id = r.absence_type_id JOIN employment e ON e.id = r.employment_id
        WHERE r.id = $1 FOR UPDATE OF r`,
      [requestId],
    );
    if (!r) throw new NotFoundException('Solicitud no encontrada');
    if (r.status !== 'pending') throw new ConflictException('La solicitud ya está resuelta');
    if (r.requested_by === actor.userId || actor.employments.some((e) => e.id === r.employment_id)) {
      throw new ForbiddenException('No puedes aprobar tu propia solicitud');
    }
    const result = await this.approvals.decideStep(tx, actor, r, approve, comment);
    if (result === 'pending') {
      await audit(tx, 'absence.step_approved', 'absence_request', requestId, { comment });
      return { ok: true, status: 'pending' };
    }
    await tx.query(
      `UPDATE absence_request SET status = $2, decided_by = $3, decided_at = now(), decision_comment = $4, current_step = NULL WHERE id = $1`,
      [requestId, result, actor.userId, comment ?? null],
    );
    const userId = await this.notifications.userIdForEmployment(tx, r.employment_id);
    if (userId) {
      await this.notifications.notifyUsers(tx, [userId], {
        type: approve ? 'absence.approved' : 'absence.rejected',
        title: `Tu solicitud de ${r.type_name.toLowerCase()} se ha ${approve ? 'aprobado' : 'rechazado'}`,
        body: `${r.start_date} → ${r.end_date}${comment ? `. Comentario: ${comment}` : ''}`,
        link: '/ausencias',
      });
    }
    await audit(tx, approve ? 'absence.approved' : 'absence.rejected', 'absence_request', requestId, { comment });
    return { ok: true, status: result };
  }

  async cancel(tx: Tx, actor: Actor, requestId: string) {
    const r = await tx.maybeOne(
      `SELECT r.*, e.company_id FROM absence_request r JOIN employment e ON e.id = r.employment_id WHERE r.id = $1 FOR UPDATE OF r`,
      [requestId],
    );
    if (!r) throw new NotFoundException();
    const access = await employmentAccess(tx, actor, r.employment_id);
    if (access !== 'self' && access !== 'hr') throw new ForbiddenException();
    if (!['pending', 'approved'].includes(r.status)) throw new ConflictException('La solicitud ya no está activa');
    const today = new Date().toISOString().slice(0, 10);
    if (access === 'self' && r.status === 'approved' && r.start_date <= today) {
      throw new ForbiddenException('Para anular una ausencia ya empezada, habla con RR. HH.');
    }
    await tx.query(`UPDATE absence_request SET status = 'cancelled', current_step = NULL WHERE id = $1`, [requestId]);
    await tx.query(`UPDATE approval_step SET status = 'cancelled' WHERE request_id = $1 AND status IN ('waiting', 'pending')`, [requestId]);
    if (r.status === 'approved' && access === 'self') {
      const mgr = await this.notifications.managerUserId(tx, r.employment_id);
      if (mgr) {
        await this.notifications.notifyUsers(tx, [mgr], {
          type: 'absence.cancelled',
          title: 'Se ha anulado una ausencia aprobada',
          link: '/ausencias?tab=equipo',
          email: false,
        });
      }
    }
    await audit(tx, 'absence.cancelled', 'absence_request', requestId);
    return { ok: true };
  }

  async mine(tx: Tx, actor: Actor) {
    if (!actor.employments.length) return [];
    const rows = await tx.query(
      `SELECT ${REQUEST_COLUMNS} FROM ${REQUEST_FROM} WHERE r.employment_id = ANY($1) ORDER BY r.start_date DESC LIMIT 200`,
      [actor.employments.map((e) => e.id)],
    );
    return this.withSteps(tx, rows);
  }

  /** Añade a cada solicitud sus pasos de aprobación (para ver en qué punto está). */
  private async withSteps(tx: Tx, rows: any[]) {
    const steps = await this.approvals.steps(tx, rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, steps: steps.filter((st: any) => st.request_id === r.id) }));
  }

  /** Solicitudes pendientes que puedo resolver. */
  async pendingForMe(tx: Tx, actor: Actor) {
    const ids = await this.approvals.pendingRequestIds(tx, actor);
    if (!ids.length) return [];
    const rows = await tx.query(`SELECT ${REQUEST_COLUMNS} FROM ${REQUEST_FROM} WHERE r.id = ANY($1) ORDER BY r.created_at`, [ids]);
    return (await this.withSteps(tx, rows)).map((r) => this.mask(actor, r));
  }

  /** Ausencias aprobadas o pendientes del equipo visible en un rango (calendario). */
  async team(tx: Tx, actor: Actor, from: string, to: string) {
    const companies = hrCompanyFilter(actor);
    const rows = await tx.query(
      `SELECT ${REQUEST_COLUMNS} FROM ${REQUEST_FROM}
        WHERE r.status IN ('approved', 'pending') AND r.start_date <= $4 AND r.end_date >= $3
          AND (e.manager_employment_id = ANY($1) OR $2::uuid[] IS NULL OR e.company_id = ANY($2)
               OR e.id = ANY($1))
        ORDER BY r.start_date`,
      [actor.employments.map((e) => e.id), companies, from, to],
    );
    return rows.map((r) => this.mask(actor, r));
  }

  /** El responsable ve que hay ausencia, pero no el motivo si es un dato de salud. */
  private mask(actor: Actor, r: any) {
    const own = actor.employments.some((e) => e.id === r.employment_id);
    if (r.sensitive && !own && !canHr(actor, r.company_id)) {
      return { ...r, type_name: 'Ausencia', type_code: null, comment: null };
    }
    return r;
  }

  async addAdjustment(tx: Tx, actor: Actor, input: { employmentId: string; year: number; days: number; reason: string }) {
    const emp = await tx.maybeOne('SELECT company_id FROM employment WHERE id = $1', [input.employmentId]);
    if (!emp) throw new NotFoundException();
    assertHr(actor, emp.company_id);
    await tx.query(
      `INSERT INTO vacation_adjustment (tenant_id, employment_id, year, days, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [tx.tenantId, input.employmentId, input.year, input.days, input.reason, tx.userId],
    );
    await audit(tx, 'vacation.adjusted', 'employment', input.employmentId, input);
    return { ok: true };
  }
}
