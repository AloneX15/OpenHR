import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Actor, assertHr, audit, canHr, employmentAccess, hrCompanyFilter } from '../common/access';
import { addDays } from '../common/dates';
import { Tx } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';
import { checkRestRules, mondayOf, PlannedShift, RestRules, RuleViolation, shiftInstants } from './rules';

export interface ShiftInput {
  employmentId: string;
  date: string;
  clear?: boolean;
  dayOff?: boolean;
  templateId?: string;
  start?: string; // HH:MM
  end?: string;
  breakMinutes?: number;
  note?: string;
}

@Injectable()
export class ShiftsService {
  constructor(private readonly notifications: NotificationsService) {}

  // ── Plantillas ───────────────────────────────────────────────────────────────────
  templates(tx: Tx, companyId?: string) {
    return tx.query(
      `SELECT id, company_id, name, start_time::text, end_time::text, break_minutes, color, active
         FROM shift_template WHERE ($1::uuid IS NULL OR company_id = $1) ORDER BY active DESC, start_time, name`,
      [companyId ?? null],
    );
  }

  async createTemplate(tx: Tx, actor: Actor, input: { companyId: string; name: string; start: string; end: string; breakMinutes: number; color: string }) {
    assertHr(actor, input.companyId);
    return tx.one(
      `INSERT INTO shift_template (tenant_id, company_id, name, start_time, end_time, break_minutes, color)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, start_time::text, end_time::text, break_minutes, color, active`,
      [tx.tenantId, input.companyId, input.name, input.start, input.end, input.breakMinutes, input.color],
    );
  }

  async updateTemplate(tx: Tx, actor: Actor, id: string, input: { name?: string; breakMinutes?: number; color?: string; active?: boolean }) {
    const t = await tx.maybeOne('SELECT company_id FROM shift_template WHERE id = $1', [id]);
    if (!t) throw new NotFoundException();
    assertHr(actor, t.company_id);
    await tx.query(
      `UPDATE shift_template SET name = coalesce($2, name), break_minutes = coalesce($3, break_minutes),
              color = coalesce($4, color), active = coalesce($5, active) WHERE id = $1`,
      [id, input.name ?? null, input.breakMinutes ?? null, input.color ?? null, input.active ?? null],
    );
    return { ok: true };
  }

  // ── Planificación ─────────────────────────────────────────────────────────────────
  /** Relaciones laborales cuyos turnos puede planificar la persona (RR. HH. o responsable directo). */
  private async plannable(tx: Tx, actor: Actor, companyId?: string) {
    const companies = hrCompanyFilter(actor);
    return tx.query(
      `SELECT e.id, e.company_id, p.first_name, p.last_name, e.job_title, coalesce(wc.timezone, 'Europe/Madrid') AS timezone,
              e.start_date::text, e.end_date::text
         FROM employment e JOIN person p ON p.id = e.person_id LEFT JOIN work_center wc ON wc.id = e.work_center_id
        WHERE (e.manager_employment_id = ANY($1) OR $2::uuid[] IS NULL OR e.company_id = ANY($2))
          AND ($3::uuid IS NULL OR e.company_id = $3)
          AND (e.end_date IS NULL OR e.end_date >= current_date - 31)
        ORDER BY p.last_name, p.first_name LIMIT 500`,
      [actor.employments.map((e) => e.id), companies, companyId ?? null],
    );
  }

  private async assertCanPlan(tx: Tx, actor: Actor, employmentId: string) {
    const access = await employmentAccess(tx, actor, employmentId);
    if (access !== 'hr' && access !== 'manager') throw new ForbiddenException('No puedes planificar turnos de esta persona');
  }

  private rows(tx: Tx, employmentIds: string[], from: string, to: string, publishedOnly: boolean) {
    return tx.query(
      `SELECT s.id, s.employment_id, s.date::text, s.shift_template_id, s.is_day_off, s.start_at, s.end_at, s.break_minutes,
              s.note, s.published_at, t.name AS template_name, t.color
         FROM shift_assignment s LEFT JOIN shift_template t ON t.id = s.shift_template_id
        WHERE s.employment_id = ANY($1) AND s.date BETWEEN $2 AND $3 ${publishedOnly ? 'AND s.published_at IS NOT NULL' : ''}
        ORDER BY s.date`,
      [employmentIds, from, to],
    );
  }

  async planner(tx: Tx, actor: Actor, q: { from: string; to: string; companyId?: string }) {
    const people = await this.plannable(tx, actor, q.companyId);
    const ids = people.map((p) => p.id);
    const shifts = await this.rows(tx, ids, q.from, q.to, false);
    const violations = await this.violations(tx, people, q.from, q.to);
    return { people, shifts, violations };
  }

  async mine(tx: Tx, actor: Actor, from: string, to: string) {
    const ids = actor.employments.map((e) => e.id);
    return ids.length ? this.rows(tx, ids, from, to, true) : [];
  }

  async save(tx: Tx, actor: Actor, items: ShiftInput[]) {
    const tzCache = new Map<string, string>();
    for (const it of items) {
      await this.assertCanPlan(tx, actor, it.employmentId);
      if (it.clear) {
        await tx.query('DELETE FROM shift_assignment WHERE employment_id = $1 AND date = $2', [it.employmentId, it.date]);
        continue;
      }
      let tz = tzCache.get(it.employmentId);
      if (!tz) {
        const row = await tx.one(
          `SELECT coalesce(wc.timezone, 'Europe/Madrid') AS tz, e.company_id FROM employment e
             LEFT JOIN work_center wc ON wc.id = e.work_center_id WHERE e.id = $1`,
          [it.employmentId],
        );
        tz = row.tz as string;
        tzCache.set(it.employmentId, tz);
      }
      let start = it.start;
      let end = it.end;
      let breakMinutes = it.breakMinutes ?? 0;
      if (it.templateId) {
        const t = await tx.maybeOne('SELECT start_time::text, end_time::text, break_minutes FROM shift_template WHERE id = $1', [it.templateId]);
        if (!t) throw new BadRequestException('Plantilla de turno no encontrada');
        start = t.start_time.slice(0, 5);
        end = t.end_time.slice(0, 5);
        breakMinutes = it.breakMinutes ?? t.break_minutes;
      }
      if (!it.dayOff && (!start || !end)) throw new BadRequestException('Indica la plantilla o las horas del turno');
      const instants = it.dayOff ? { startAt: null, endAt: null } : shiftInstants(it.date, start!, end!, tz);
      await tx.query(
        `INSERT INTO shift_assignment (tenant_id, employment_id, date, shift_template_id, is_day_off, start_at, end_at, break_minutes,
                                       note, created_by, published_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,now())
         ON CONFLICT (employment_id, date) DO UPDATE SET shift_template_id = EXCLUDED.shift_template_id,
           is_day_off = EXCLUDED.is_day_off, start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at,
           break_minutes = EXCLUDED.break_minutes, note = EXCLUDED.note, published_at = NULL, updated_at = now()`,
        [tx.tenantId, it.employmentId, it.date, it.templateId ?? null, Boolean(it.dayOff), instants.startAt, instants.endAt, breakMinutes, it.note ?? null, tx.userId],
      );
    }
    return { saved: items.length };
  }

  /** Publica los cambios pendientes del rango y avisa a cada persona afectada. */
  async publish(tx: Tx, actor: Actor, q: { from: string; to: string; companyId?: string }) {
    const people = await this.plannable(tx, actor, q.companyId);
    const published = await tx.query<{ employment_id: string }>(
      `UPDATE shift_assignment SET published_at = now()
        WHERE employment_id = ANY($1) AND date BETWEEN $2 AND $3 AND published_at IS NULL
        RETURNING employment_id`,
      [people.map((p) => p.id), q.from, q.to],
    );
    const affected = [...new Set(published.map((p) => p.employment_id))];
    for (const employmentId of affected) {
      const userId = await this.notifications.userIdForEmployment(tx, employmentId);
      if (userId) {
        await this.notifications.notifyUsers(tx, [userId], {
          type: 'shifts.published',
          title: 'Tienes turnos nuevos o modificados',
          body: `Revisa tu horario del ${q.from} al ${q.to}.`,
          link: '/horario',
        });
      }
    }
    await audit(tx, 'shifts.published', 'shift_assignment', null, { ...q, shifts: published.length });
    return { published: published.length, people: affected.length };
  }

  /** Incumplimientos de las reglas de descanso en el rango (incluye borradores). */
  async violations(tx: Tx, people: any[], from: string, to: string): Promise<RuleViolation[]> {
    if (!people.length) return [];
    const margin = { from: addDays(mondayOf(from), -7), to: addDays(to, 7) };
    const rows = await this.rows(tx, people.map((p) => p.id), margin.from, margin.to, false);
    const companies = await tx.query('SELECT id, min_rest_between_shifts_minutes, max_daily_ordinary_minutes, min_weekly_rest_minutes FROM company');
    const rulesBy = new Map<string, RestRules>(
      companies.map((c) => [
        c.id,
        {
          minRestBetweenShiftsMinutes: c.min_rest_between_shifts_minutes,
          maxDailyOrdinaryMinutes: c.max_daily_ordinary_minutes,
          minWeeklyRestMinutes: c.min_weekly_rest_minutes,
        },
      ]),
    );
    const weeks: string[] = [];
    for (let m = mondayOf(from); m <= to; m = addDays(m, 7)) weeks.push(m);
    const out: RuleViolation[] = [];
    for (const p of people) {
      const own: PlannedShift[] = rows
        .filter((r) => r.employment_id === p.id && !r.is_day_off)
        .map((r) => ({ employmentId: p.id, date: r.date, startAt: r.start_at, endAt: r.end_at, breakMinutes: r.break_minutes }));
      // Sin turnos esa semana no hay nada que comprobar (manda el horario semanal).
      const plannedWeeks = weeks.filter((w) => own.some((s) => s.date >= w && s.date <= addDays(w, 6)));
      if (!plannedWeeks.length) continue;
      out.push(...checkRestRules(own, rulesBy.get(p.company_id)!, plannedWeeks, p.timezone).map((v) => ({ ...v, employmentId: p.id })));
    }
    return out.filter((v) => v.date >= mondayOf(from) && v.date <= to);
  }

  async updateRules(tx: Tx, actor: Actor, companyId: string, r: Partial<Record<'minRestBetweenShiftsMinutes' | 'maxDailyOrdinaryMinutes' | 'minWeeklyRestMinutes' | 'maxYearlyOvertimeMinutes', number>>) {
    if (!canHr(actor, companyId)) throw new ForbiddenException();
    await tx.query(
      `UPDATE company SET min_rest_between_shifts_minutes = coalesce($2, min_rest_between_shifts_minutes),
              max_daily_ordinary_minutes = coalesce($3, max_daily_ordinary_minutes),
              min_weekly_rest_minutes = coalesce($4, min_weekly_rest_minutes),
              max_yearly_overtime_minutes = coalesce($5, max_yearly_overtime_minutes) WHERE id = $1`,
      [companyId, r.minRestBetweenShiftsMinutes ?? null, r.maxDailyOrdinaryMinutes ?? null, r.minWeeklyRestMinutes ?? null, r.maxYearlyOvertimeMinutes ?? null],
    );
    await audit(tx, 'company.work_rules_updated', 'company', companyId, r);
    return { ok: true };
  }
}
