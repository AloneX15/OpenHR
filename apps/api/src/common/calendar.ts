import { eachDay, isoWeekday } from './dates';
import { Tx } from '../db/db.service';

export interface AbsenceDay {
  requestId: string;
  typeId: string;
  code: string;
  name: string;
  paid: boolean;
  consumesHourBank: boolean;
}

/** Turno publicado de un día: sustituye a la jornada semanal. */
export interface ShiftDay {
  minutes: number; // duración menos pausa; 0 si es día libre
  isDayOff: boolean;
  startAt: Date | null;
  endAt: Date | null;
  name: string | null;
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
  /** Turnos publicados por fecha (opcional: sin turnos manda el horario semanal). */
  shifts?: Map<string, ShiftDay>;
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
    `SELECT r.id, r.employment_id, r.start_date::text, r.end_date::text, t.id AS type_id, t.code, t.name, t.paid,
            t.consumes_hour_bank
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
      shifts: new Map(),
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
      cal.absences.set(d, {
        requestId: a.id,
        typeId: a.type_id,
        code: a.code,
        name: a.name,
        paid: a.paid,
        consumesHourBank: a.consumes_hour_bank,
      });
    }
  }
  const shifts = await tx.query(
    `SELECT s.employment_id, s.date::text, s.is_day_off, s.start_at, s.end_at, s.break_minutes, t.name
       FROM shift_assignment s LEFT JOIN shift_template t ON t.id = s.shift_template_id
      WHERE s.employment_id = ANY($1) AND s.date BETWEEN $2 AND $3 AND s.published_at IS NOT NULL`,
    [employmentIds, from, to],
  );
  for (const sh of shifts) {
    const cal = result.get(sh.employment_id);
    if (!cal) continue;
    const minutes = sh.is_day_off ? 0 : Math.max(0, (sh.end_at.getTime() - sh.start_at.getTime()) / 60000 - sh.break_minutes);
    cal.shifts!.set(sh.date, { minutes: Math.round(minutes), isDayOff: sh.is_day_off, startAt: sh.start_at, endAt: sh.end_at, name: sh.name });
  }
  return result;
}

export function isEmployed(cal: Pick<EmploymentCalendar, 'startDate' | 'endDate'>, date: string): boolean {
  return date >= cal.startDate && (!cal.endDate || date <= cal.endDate);
}

/**
 * Minutos de jornada planificada, sin descontar ausencias: el turno publicado si lo hay
 * (aunque sea festivo: se ha planificado trabajar) o, si no, el horario semanal.
 */
export function scheduledMinutes(cal: Pick<EmploymentCalendar, 'schedule' | 'startDate' | 'endDate' | 'shifts'>, date: string): number {
  if (!isEmployed(cal, date)) return 0;
  const shift = cal.shifts?.get(date);
  if (shift) return shift.minutes;
  return Number(cal.schedule[String(isoWeekday(date))] ?? 0);
}

/** Día laborable: tiene jornada planificada y no es festivo (salvo turno asignado). */
export function isWorkingDay(cal: EmploymentCalendar, date: string): boolean {
  if (cal.shifts?.has(date)) return scheduledMinutes(cal, date) > 0;
  return scheduledMinutes(cal, date) > 0 && !cal.holidays.has(date);
}

/** Jornada que se espera trabajar ese día: 0 si es festivo o hay ausencia aprobada. */
export function expectedMinutes(cal: EmploymentCalendar, date: string): number {
  if (!isWorkingDay(cal, date) || cal.absences.has(date)) return 0;
  return scheduledMinutes(cal, date);
}
