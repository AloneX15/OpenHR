/**
 * Cálculo del registro retributivo (art. 28.2 ET, RD 902/2020): medias y medianas de las
 * retribuciones, desagregadas por sexo y por grupo profesional, equiparadas a jornada
 * completa y anualizadas. Funciones puras, sin acceso a datos.
 */

export type Sex = 'female' | 'male' | 'other' | null;
export const CONCEPTS = ['base', 'complements', 'extraSalary', 'total'] as const;
export type Concept = (typeof CONCEPTS)[number];

export interface PayRow {
  employmentId: string;
  group: string;
  sex: Sex;
  /** Importes anuales a jornada completa. */
  base: number;
  complements: number;
  extraSalary: number;
}

export interface Stat {
  n: number;
  mean: number | null;
  median: number | null;
}

export interface GroupStats {
  group: string;
  women: Record<Concept, Stat>;
  men: Record<Concept, Stat>;
  /** (hombres − mujeres) / hombres, en %, sobre la media y la mediana del total. */
  gapMeanPct: number | null;
  gapMedianPct: number | null;
  /** RD 902/2020 art. 6: diferencias de al menos el 25 % deben justificarse (empresas de 50 o más). */
  flagged: boolean;
  other: number;
  unknown: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function mean(values: number[]): number | null {
  return values.length ? round2(values.reduce((a, b) => a + b, 0) / values.length) : null;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return round2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

const total = (r: PayRow) => r.base + r.complements + r.extraSalary;
const valueOf = (r: PayRow, c: Concept) => (c === 'total' ? total(r) : r[c]);

function stats(rows: PayRow[]): Record<Concept, Stat> {
  return Object.fromEntries(
    CONCEPTS.map((c) => {
      const v = rows.map((r) => valueOf(r, c));
      return [c, { n: v.length, mean: mean(v), median: median(v) }];
    }),
  ) as Record<Concept, Stat>;
}

export function gapPct(men: number | null, women: number | null): number | null {
  if (men === null || women === null || men === 0) return null;
  return round2(((men - women) / men) * 100);
}

/** Equipara un importe a jornada completa: importe × jornada completa / jornada real. */
export function toFullTime(amount: number, weeklyMinutes: number, fullTimeWeeklyMinutes: number): number {
  if (weeklyMinutes <= 0) return 0;
  return round2((amount * fullTimeWeeklyMinutes) / weeklyMinutes);
}

export function payRegister(rows: PayRow[], threshold = 25): { groups: GroupStats[]; overall: GroupStats } {
  const build = (group: string, list: PayRow[]): GroupStats => {
    const women = stats(list.filter((r) => r.sex === 'female'));
    const men = stats(list.filter((r) => r.sex === 'male'));
    const gapMeanPct = gapPct(men.total.mean, women.total.mean);
    const gapMedianPct = gapPct(men.total.median, women.total.median);
    return {
      group,
      women,
      men,
      gapMeanPct,
      gapMedianPct,
      flagged: Math.abs(gapMeanPct ?? 0) >= threshold || Math.abs(gapMedianPct ?? 0) >= threshold,
      other: list.filter((r) => r.sex === 'other').length,
      unknown: list.filter((r) => r.sex === null).length,
    };
  };
  const byGroup = new Map<string, PayRow[]>();
  for (const r of rows) byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r]);
  const groups = [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b, 'es')).map(([g, list]) => build(g, list));
  return { groups, overall: build('Total', rows) };
}
