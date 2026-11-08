import { Injectable, NotFoundException } from '@nestjs/common';
import { Actor, assertEmploymentAccess, assertHr, audit } from '../common/access';
import { EmploymentCalendar, expectedMinutes, isEmployed, loadCalendars, scheduledMinutes } from '../common/calendar';
import { Tx } from '../db/db.service';
import { entriesForDates } from './entries';
import { DaySummary, dailySummaries } from './worktime';

export interface DayBalance {
  date: string;
  worked: number;
  expected: number;
  /** Minutos que el día aporta a la bolsa (negativo si la consume). */
  bank: number;
}

/**
 * Aportación de cada día a la bolsa de horas: trabajado menos teórico, y, si el día tiene
 * una ausencia que consume la bolsa (compensación de horas), menos la jornada planificada.
 */
export function dayBalances(cal: EmploymentCalendar, days: DaySummary[]): DayBalance[] {
  return days
    .filter((d) => isEmployed(cal, d.date))
    .map((d) => {
      const expected = expectedMinutes(cal, d.date);
      const absence = cal.absences.get(d.date);
      const consumed = absence?.consumesHourBank ? scheduledMinutes(cal, d.date) : 0;
      return { date: d.date, worked: d.workedMinutes, expected, bank: d.workedMinutes - expected - consumed };
    });
}

@Injectable()
export class HourBankService {
  async summary(tx: Tx, actor: Actor, employmentId: string, year: number, today = new Date().toISOString().slice(0, 10)) {
    await assertEmploymentAccess(tx, actor, employmentId);
    const emp = await tx.maybeOne(
      `SELECT e.hour_bank_enabled, e.hour_bank_start::text, e.start_date::text, c.max_yearly_overtime_minutes
         FROM employment e JOIN company c ON c.id = e.company_id WHERE e.id = $1`,
      [employmentId],
    );
    if (!emp) throw new NotFoundException();
    const yearFrom = `${year}-01-01`;
    const yearTo = `${year}-12-31` < today ? `${year}-12-31` : today;
    const bankFrom = emp.hour_bank_enabled ? [emp.hour_bank_start ?? emp.start_date, emp.start_date].sort().reverse()[0] : null;
    const from = bankFrom && bankFrom < yearFrom ? bankFrom : yearFrom;
    const to = today;
    if (from > to) return { enabled: emp.hour_bank_enabled, balance: 0, months: [], surplusYear: 0, overtimeLimit: emp.max_yearly_overtime_minutes, adjustments: [] };

    const cal = (await loadCalendars(tx, [employmentId], from, to)).get(employmentId)!;
    const entries = await entriesForDates(tx, employmentId, from, to, cal.timezone);
    const balances = dayBalances(cal, dailySummaries(entries, cal.timezone, from, to));

    const adjustments = await tx.query(
      `SELECT a.id, a.date::text, a.minutes, a.kind, a.reason, a.created_at,
              coalesce(p.first_name || ' ' || p.last_name, u.email) AS created_by_name
         FROM hour_bank_adjustment a LEFT JOIN app_user u ON u.id = a.created_by LEFT JOIN person p ON p.id = u.person_id
        WHERE a.employment_id = $1 ORDER BY a.date DESC, a.created_at DESC`,
      [employmentId],
    );
    const balance = bankFrom
      ? balances.filter((b) => b.date >= bankFrom).reduce((s, b) => s + b.bank, 0) +
        adjustments.filter((a) => a.date >= bankFrom).reduce((s, a) => s + a.minutes, 0)
      : null;

    const months = new Map<string, { month: string; worked: number; expected: number; diff: number; surplus: number }>();
    for (const b of balances.filter((x) => x.date >= yearFrom && x.date <= yearTo)) {
      const key = b.date.slice(0, 7);
      const m = months.get(key) ?? { month: key, worked: 0, expected: 0, diff: 0, surplus: 0 };
      m.worked += b.worked;
      m.expected += b.expected;
      m.diff += b.bank;
      m.surplus += Math.max(0, b.worked - b.expected);
      months.set(key, m);
    }
    const surplusYear = [...months.values()].reduce((s, m) => s + m.surplus, 0);
    return {
      enabled: emp.hour_bank_enabled,
      since: bankFrom,
      balance,
      months: [...months.values()],
      // Exceso diario sobre la jornada en el año: posibles horas extra (art. 35 ET).
      surplusYear,
      overtimeLimit: emp.max_yearly_overtime_minutes,
      adjustments,
    };
  }

  async adjust(tx: Tx, actor: Actor, input: { employmentId: string; date: string; minutes: number; kind: 'opening' | 'paid' | 'adjustment'; reason: string }) {
    const emp = await tx.maybeOne('SELECT company_id FROM employment WHERE id = $1', [input.employmentId]);
    if (!emp) throw new NotFoundException();
    assertHr(actor, emp.company_id);
    const row = await tx.one(
      `INSERT INTO hour_bank_adjustment (tenant_id, employment_id, date, minutes, kind, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [tx.tenantId, input.employmentId, input.date, input.minutes, input.kind, input.reason, tx.userId],
    );
    await audit(tx, 'hour_bank.adjusted', 'employment', input.employmentId, input);
    return row;
  }
}
