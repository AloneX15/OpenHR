import { addDays, isoWeekday, zonedToUtc } from '../common/dates';

/** Reglas de descanso y jornada. Valores por defecto del Estatuto de los Trabajadores. */
export interface RestRules {
  minRestBetweenShiftsMinutes: number; // art. 34.3: 12 h entre jornadas
  maxDailyOrdinaryMinutes: number; // art. 34.3: 9 h de trabajo efectivo
  minWeeklyRestMinutes: number; // art. 37.1: día y medio ininterrumpido (acumulable en 14 días)
}

export const DEFAULT_RULES: RestRules = {
  minRestBetweenShiftsMinutes: 12 * 60,
  maxDailyOrdinaryMinutes: 9 * 60,
  minWeeklyRestMinutes: 36 * 60,
};

export interface PlannedShift {
  employmentId: string;
  date: string;
  startAt: Date;
  endAt: Date;
  breakMinutes: number;
}

export type RuleCode = 'rest_between_shifts' | 'daily_max' | 'weekly_rest' | 'overlap';

export interface RuleViolation {
  employmentId: string;
  date: string;
  rule: RuleCode;
  message: string;
}

const hours = (m: number) => {
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return r ? `${h} h ${r} min` : `${h} h`;
};

/**
 * Comprueba las reglas de descanso de los turnos de UNA relación laboral.
 * `weeks` son los lunes (AAAA-MM-DD) de las semanas a comprobar; los turnos deben incluir
 * al menos la semana anterior y la siguiente para que los descansos de frontera cuenten.
 */
export function checkRestRules(shifts: PlannedShift[], rules: RestRules, weeks: string[], timezone: string): RuleViolation[] {
  const out: RuleViolation[] = [];
  const sorted = [...shifts].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const weekSet = new Set(weeks);
  const inChecked = (date: string) => weekSet.has(mondayOf(date));

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const worked = (s.endAt.getTime() - s.startAt.getTime()) / 60000 - s.breakMinutes;
    if (inChecked(s.date) && worked > rules.maxDailyOrdinaryMinutes) {
      out.push({
        employmentId: s.employmentId,
        date: s.date,
        rule: 'daily_max',
        message: `Turno de ${hours(worked)} de trabajo efectivo: supera el máximo de ${hours(rules.maxDailyOrdinaryMinutes)}`,
      });
    }
    const next = sorted[i + 1];
    if (!next || !inChecked(next.date)) continue;
    const rest = (next.startAt.getTime() - s.endAt.getTime()) / 60000;
    if (rest < 0) {
      out.push({ employmentId: s.employmentId, date: next.date, rule: 'overlap', message: 'El turno se solapa con el anterior' });
    } else if (rest < rules.minRestBetweenShiftsMinutes) {
      out.push({
        employmentId: s.employmentId,
        date: next.date,
        rule: 'rest_between_shifts',
        message: `Solo ${hours(rest)} de descanso desde el turno anterior (mínimo ${hours(rules.minRestBetweenShiftsMinutes)})`,
      });
    }
  }

  // Descanso semanal: el mayor hueco sin trabajar dentro de cada semana (lunes 00:00 a
  // lunes 00:00 siguiente) debe llegar al mínimo, o el doble acumulado en 14 días.
  for (const monday of weeks) {
    const weekStart = zonedToUtc(monday, '00:00', timezone);
    const weekEnd = zonedToUtc(addDays(monday, 7), '00:00', timezone);
    const twoWeekStart = zonedToUtc(addDays(monday, -7), '00:00', timezone);
    const own = longestGap(sorted, weekStart, weekEnd);
    if (own >= rules.minWeeklyRestMinutes) continue;
    // Acumulación en 14 días (esta semana y la anterior): dos huecos que sumen el doble.
    const accumulated = twoLongestGaps(sorted, twoWeekStart, weekEnd);
    if (accumulated >= 2 * rules.minWeeklyRestMinutes) continue;
    const employmentId = sorted[0]?.employmentId ?? '';
    out.push({
      employmentId,
      date: monday,
      rule: 'weekly_rest',
      message: `La semana del ${monday} no tiene ${hours(rules.minWeeklyRestMinutes)} seguidas de descanso (máximo: ${hours(own)})`,
    });
  }
  return out;
}

function gaps(shifts: PlannedShift[], from: Date, to: Date): number[] {
  const inside = shifts.filter((s) => s.endAt > from && s.startAt < to);
  const result: number[] = [];
  let cursor = from;
  for (const s of inside) {
    if (s.startAt > cursor) result.push((s.startAt.getTime() - cursor.getTime()) / 60000);
    if (s.endAt > cursor) cursor = s.endAt;
  }
  if (to > cursor) result.push((to.getTime() - cursor.getTime()) / 60000);
  return result;
}

function longestGap(shifts: PlannedShift[], from: Date, to: Date): number {
  return Math.max(0, ...gaps(shifts, from, to));
}

function twoLongestGaps(shifts: PlannedShift[], from: Date, to: Date): number {
  const g = gaps(shifts, from, to).sort((a, b) => b - a);
  return (g[0] ?? 0) + (g[1] ?? 0);
}

export function mondayOf(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

/** Instantes de inicio y fin de un turno a partir de horas locales (cruza medianoche si fin <= inicio). */
export function shiftInstants(date: string, startTime: string, endTime: string, timezone: string) {
  const startAt = zonedToUtc(date, startTime.slice(0, 5), timezone);
  const endDate = endTime.slice(0, 5) <= startTime.slice(0, 5) ? addDays(date, 1) : date;
  const endAt = zonedToUtc(endDate, endTime.slice(0, 5), timezone);
  return { startAt, endAt };
}
