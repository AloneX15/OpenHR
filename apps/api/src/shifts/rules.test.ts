import { describe, expect, it } from 'vitest';
import { addDays } from '../common/dates';
import { checkRestRules, DEFAULT_RULES, PlannedShift, shiftInstants } from './rules';

const TZ = 'Europe/Madrid';
const shift = (date: string, start: string, end: string, breakMinutes = 0): PlannedShift => ({
  employmentId: 'e',
  date,
  breakMinutes,
  ...shiftInstants(date, start, end, TZ),
});

// Semana del lunes 16 de noviembre de 2026.
const MON = '2026-11-16';
const week = (start: string, end: string, days = 5) => Array.from({ length: days }, (_, i) => shift(addDays(MON, i), start, end, 30));

describe('reglas de descanso', () => {
  it('una semana normal de lunes a viernes cumple todo', () => {
    expect(checkRestRules(week('09:00', '17:30'), DEFAULT_RULES, [MON], TZ)).toEqual([]);
  });

  it('detecta menos de 12 horas entre turnos (cierre y apertura)', () => {
    const v = checkRestRules([shift(MON, '14:00', '23:00'), shift(addDays(MON, 1), '07:00', '15:00')], DEFAULT_RULES, [MON], TZ);
    expect(v).toContainEqual(expect.objectContaining({ rule: 'rest_between_shifts', date: addDays(MON, 1) }));
  });

  it('detecta más de 9 horas de trabajo efectivo', () => {
    const v = checkRestRules([shift(MON, '08:00', '19:00', 60)], DEFAULT_RULES, [MON], TZ);
    expect(v).toContainEqual(expect.objectContaining({ rule: 'daily_max' }));
  });

  it('los turnos de noche cruzan medianoche', () => {
    const s = shift(MON, '22:00', '06:00');
    expect((s.endAt.getTime() - s.startAt.getTime()) / 3600000).toBe(8);
  });

  it('detecta una semana sin día y medio de descanso', () => {
    const seven = week('09:00', '17:00', 7);
    const before = Array.from({ length: 7 }, (_, i) => shift(addDays(MON, i - 7), '09:00', '17:00'));
    const v = checkRestRules([...before, ...seven], DEFAULT_RULES, [MON], TZ);
    expect(v).toContainEqual(expect.objectContaining({ rule: 'weekly_rest', date: MON }));
  });

  it('admite acumular el descanso semanal en 14 días', () => {
    // Semana anterior libre de jueves a domingo; esta semana se trabajan los 7 días.
    const before = [0, 1, 2].map((i) => shift(addDays(MON, i - 7), '09:00', '17:00'));
    const v = checkRestRules([...before, ...week('09:00', '17:00', 7)], DEFAULT_RULES, [MON], TZ);
    expect(v.filter((x) => x.rule === 'weekly_rest')).toEqual([]);
  });
});
