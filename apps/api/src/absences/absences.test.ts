import { describe, expect, it } from 'vitest';
import { EmploymentCalendar } from '../common/calendar';
import { countAbsenceDays, proratedAllowance } from './absences.service';

const cal = (): EmploymentCalendar => ({
  employmentId: 'e',
  companyId: 'c',
  workCenterId: null,
  timezone: 'Europe/Madrid',
  schedule: { '1': 480, '2': 480, '3': 480, '4': 480, '5': 480, '6': 0, '7': 0 },
  startDate: '2026-01-01',
  endDate: null,
  holidays: new Map([['2026-12-08', 'Inmaculada']]),
  absences: new Map(),
});

describe('ausencias', () => {
  it('cuenta días laborables sin fines de semana ni festivos', () => {
    // Del lunes 7 al domingo 13 de diciembre de 2026; el martes 8 es festivo.
    expect(countAbsenceDays(cal(), 'working', '2026-12-07', '2026-12-13')).toBe(4);
    expect(countAbsenceDays(cal(), 'calendar', '2026-12-07', '2026-12-13')).toBe(7);
  });

  it('prorratea las vacaciones del primer año', () => {
    expect(proratedAllowance(22, 2026, '2020-03-01', null)).toBe(22);
    expect(proratedAllowance(22, 2026, '2026-07-01', null)).toBe(11);
    expect(proratedAllowance(22, 2026, '2025-01-01', '2026-03-31')).toBe(5.5);
    expect(proratedAllowance(22, 2026, '2027-01-01', null)).toBe(0);
  });
});
