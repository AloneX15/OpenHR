import { describe, expect, it } from 'vitest';
import { gapPct, median, payRegister, PayRow, toFullTime } from './pay-register';

const row = (group: string, sex: PayRow['sex'], base: number, complements = 0, extraSalary = 0): PayRow => ({
  employmentId: Math.random().toString(),
  group,
  sex,
  base,
  complements,
  extraSalary,
});

describe('registro retributivo', () => {
  it('mediana con número par e impar', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('equipara a jornada completa', () => {
    expect(toFullTime(15000, 1200, 2400)).toBe(30000);
    expect(toFullTime(30000, 2400, 2400)).toBe(30000);
  });

  it('brecha = (hombres − mujeres) / hombres', () => {
    expect(gapPct(30000, 24000)).toBe(20);
    expect(gapPct(null, 24000)).toBeNull();
  });

  it('agrupa por grupo profesional y marca brechas de al menos el 25 %', () => {
    const r = payRegister([
      row('G1', 'female', 20000, 2000),
      row('G1', 'female', 22000),
      row('G1', 'male', 30000, 4000, 1000),
      row('G2', 'female', 30000),
      row('G2', 'male', 31000),
      row('G2', null, 50000),
    ]);
    const g1 = r.groups.find((g) => g.group === 'G1')!;
    expect(g1.women.total).toEqual({ n: 2, mean: 22000, median: 22000 });
    expect(g1.men.base).toEqual({ n: 1, mean: 30000, median: 30000 });
    expect(g1.gapMeanPct).toBe(37.14);
    expect(g1.flagged).toBe(true);
    const g2 = r.groups.find((g) => g.group === 'G2')!;
    expect(g2.flagged).toBe(false);
    expect(g2.unknown).toBe(1);
    expect(r.overall.women.total.n).toBe(3);
  });
});
