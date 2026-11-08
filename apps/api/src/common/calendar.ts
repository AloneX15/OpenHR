import { eachDay, isoWeekday } from './dates';
import { Tx } from '../db/db.service';

export interface AbsenceDay {
  requestId: string;
  typeId: string;
  code: string;
  name: string;
  paid: boolean;
}

export interface EmploymentCalendar {
  employmentId: string;
  companyId: string;
  workCenterId: string | null;
  timezone: string;
  schedule: Record<string, number>;
  startDate: string;
  endDate: string | null;
  holidays: Map<string, string>;
  absences: Map<string, AbsenceDay>;
}

const iso = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

/**
 * Carga, para varias relaciones laborales, lo necesario para saber su jornada teórica
 * en un rango: horario semanal, festivos aplicables y ausencias aprobadas.
 */
export async function loadCalendars(tx: Tx, employmentIds: string[], from: string, to: string) {
  const result = new Map<string, EmploymentCalendar>();
  if (!employmentIds.length) return result;
  const emps = await tx.query(
    `SELECT e.id, e.company_id, e.work_center_id, e.schedule, e.start_date::text, e.end_date::text,
            coalesce(wc.timezone, 'Europe/Madrid') AS timezone
       FROM employment e LEFT JOIN work_center wc ON wc.id = e.work_center_id
      WHERE e.id = ANY($1)`,
    [employmentIds],
  );
  const holidays = await tx.query(
    `SELECT date::text, name, company_id, work_center_id FROM holiday WHERE date BETWEEN $1 AND $2`,
    [from, to],
  );
  const absences = await tx.query(
    `SELECT r.id, r.employment_id, r.start_date::text, r.end_date::text, t.id AS type_id, t.code, t.name, t.paid
       FROM absence_request r JOIN absence_type t ON t.id = r.absence_type_id
      WHERE r.employment_id = ANY($1) AND r.status = 'approved' AND r.start_date <= $3 AND r.end_date >= $2`,
    [employmentIds, from, to],
  );
  for (const e of emps) {
    const cal: EmploymentCalendar = {
      employmentId: e.id,
      companyId: e.company_id,
      workCenterId: e.work_center_id,
      timezone: e.timezone,
      schedule: e.schedule,
      startDate: iso(e.start_date),
      endDate: e.end_date ? iso(e.end_date) : null,
      holidays: new Map(),
      absences: new Map(),
    };
    for (const h of holidays) {
      const applies =
        (!h.company_id && !h.work_center_id) ||
        (h.work_center_id ? h.work_center_id === e.work_center_id : h.company_id === e.company_id);
      if (applies) cal.holidays.set(iso(h.date), h.name);
    }
    result.set(e.id, cal);
  }
  for (const a of absences) {
    const cal = result.get(a.employment_id);
    if (!cal) continue;
    const start = iso(a.start_date) < from ? from : iso(a.start_date);
    const end = iso(a.end_date) > to ? to : iso(a.end_date);
    for (const d of eachDay(start, end)) {
      cal.absences.set(d, { requestId: a.id, typeId: a.type_id, code: a.code, name: a.name, paid: a.paid });
    }
  }
  return result;
}

export function isEmployed(cal: Pick<EmploymentCalendar, 'startDate' | 'endDate'>, date: string): boolean {
  return date >= cal.startDate && (!cal.endDate || date <= cal.endDate);
}

/** Minutos de jornada teórica del horario semanal, sin descontar festivos ni ausencias. */
export function scheduledMinutes(cal: Pick<EmploymentCalendar, 'schedule' | 'startDate' | 'endDate'>, date: string): number {
  if (!isEmployed(cal, date)) return 0;
  return Number(cal.schedule[String(isoWeekday(date))] ?? 0);
}

/** Día laborable: tiene jornada y no es festivo (las ausencias no cuentan aquí). */
export function isWorkingDay(cal: EmploymentCalendar, date: string): boolean {
  return scheduledMinutes(cal, date) > 0 && !cal.holidays.has(date);
}

/** Jornada que se espera trabajar ese día: 0 si es festivo o hay ausencia aprobada. */
export function expectedMinutes(cal: EmploymentCalendar, date: string): number {
  if (!isWorkingDay(cal, date) || cal.absences.has(date)) return 0;
  return scheduledMinutes(cal, date);
}
