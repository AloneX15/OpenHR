import { Injectable, NotFoundException } from '@nestjs/common';
import { Actor, assertHr, audit } from '../common/access';
import { Tx } from '../db/db.service';
import { toCsv } from '../exports/exports.service';
import { CONCEPTS, payRegister, PayRow, toFullTime } from './pay-register';

const CONCEPT_LABEL = { base: 'Salario base', complements: 'Complementos salariales', extraSalary: 'Percepciones extrasalariales', total: 'Total' };
const fmt = (n: number | null) => (n === null ? '' : n.toFixed(2).replace('.', ','));

@Injectable()
export class PayService {
  private async companyOf(tx: Tx, employmentId: string) {
    const e = await tx.maybeOne('SELECT company_id FROM employment WHERE id = $1', [employmentId]);
    if (!e) throw new NotFoundException();
    return e.company_id as string;
  }

  async history(tx: Tx, actor: Actor, employmentId: string) {
    assertHr(actor, await this.companyOf(tx, employmentId));
    return tx.query(
      `SELECT c.id, c.effective_from::text, c.base_annual::float, c.complements_annual::float, c.extra_salary_annual::float, c.note, c.created_at,
              coalesce(p.first_name || ' ' || p.last_name, u.email) AS created_by_name
         FROM compensation c LEFT JOIN app_user u ON u.id = c.created_by LEFT JOIN person p ON p.id = u.person_id
        WHERE c.employment_id = $1 ORDER BY c.effective_from DESC`,
      [employmentId],
    );
  }

  async add(
    tx: Tx,
    actor: Actor,
    input: { employmentId: string; effectiveFrom: string; baseAnnual: number; complementsAnnual: number; extraSalaryAnnual: number; note?: string },
  ) {
    assertHr(actor, await this.companyOf(tx, input.employmentId));
    const row = await tx.one(
      `INSERT INTO compensation (tenant_id, employment_id, effective_from, base_annual, complements_annual, extra_salary_annual, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (employment_id, effective_from) DO UPDATE SET base_annual = EXCLUDED.base_annual,
         complements_annual = EXCLUDED.complements_annual, extra_salary_annual = EXCLUDED.extra_salary_annual, note = EXCLUDED.note
       RETURNING id`,
      [tx.tenantId, input.employmentId, input.effectiveFrom, input.baseAnnual, input.complementsAnnual, input.extraSalaryAnnual, input.note ?? null, actor.userId],
    );
    // Solo se audita que hubo cambio, no los importes.
    await audit(tx, 'compensation.saved', 'employment', input.employmentId, { effectiveFrom: input.effectiveFrom });
    return row;
  }

  async remove(tx: Tx, actor: Actor, id: string) {
    const c = await tx.maybeOne('SELECT employment_id FROM compensation WHERE id = $1', [id]);
    if (!c) throw new NotFoundException();
    assertHr(actor, await this.companyOf(tx, c.employment_id));
    await tx.query('DELETE FROM compensation WHERE id = $1', [id]);
    await audit(tx, 'compensation.deleted', 'employment', c.employment_id);
    return { ok: true };
  }

  /**
   * Registro retributivo de una sociedad y un año: personas con relación laboral en algún
   * momento del año y retribución vigente a 31 de diciembre (o a su baja), equiparada a
   * jornada completa.
   */
  async register(tx: Tx, actor: Actor, companyId: string, year: number, groupBy: 'professional_group' | 'job_title') {
    assertHr(actor, companyId);
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const company = await tx.one('SELECT name, tax_id, full_time_weekly_minutes FROM company WHERE id = $1', [companyId]);
    const rows = await tx.query(
      `SELECT e.id, e.weekly_minutes, coalesce(nullif(e.${groupBy}, ''), 'Sin clasificar') AS grp, p.sex,
              c.base_annual::float AS base, c.complements_annual::float AS complements, c.extra_salary_annual::float AS extra
         FROM employment e JOIN person p ON p.id = e.person_id
         JOIN LATERAL (
           SELECT * FROM compensation c WHERE c.employment_id = e.id AND c.effective_from <= least($3::date, coalesce(e.end_date, $3::date))
            ORDER BY c.effective_from DESC LIMIT 1) c ON true
        WHERE e.company_id = $1 AND e.start_date <= $3 AND (e.end_date IS NULL OR e.end_date >= $2)`,
      [companyId, from, to],
    );
    const missing = await tx.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM employment e
        WHERE e.company_id = $1 AND e.start_date <= $3 AND (e.end_date IS NULL OR e.end_date >= $2)
          AND NOT EXISTS (SELECT 1 FROM compensation c WHERE c.employment_id = e.id)`,
      [companyId, from, to],
    );
    const ft = company.full_time_weekly_minutes;
    const payRows: PayRow[] = rows.map((r) => ({
      employmentId: r.id,
      group: r.grp,
      sex: r.sex,
      base: toFullTime(r.base, r.weekly_minutes, ft),
      complements: toFullTime(r.complements, r.weekly_minutes, ft),
      extraSalary: toFullTime(r.extra, r.weekly_minutes, ft),
    }));
    await audit(tx, 'report.pay_register', 'company', companyId, { year, groupBy });
    return {
      company: { name: company.name, taxId: company.tax_id },
      year,
      groupBy,
      fullTimeWeeklyMinutes: ft,
      people: payRows.length,
      withoutCompensation: missing.n,
      // Obligación de auditoría retributiva y justificación de brechas: 50 personas o más.
      fiftyOrMore: payRows.length + missing.n >= 50,
      ...payRegister(payRows),
    };
  }

  registerCsv(r: Awaited<ReturnType<PayService['register']>>): Buffer {
    const header = ['Grupo', 'Concepto', 'Mujeres (n)', 'Mujeres media', 'Mujeres mediana', 'Hombres (n)', 'Hombres media', 'Hombres mediana', 'Brecha media %', 'Brecha mediana %'];
    const lines: (string | number | null)[][] = [
      [`Registro retributivo ${r.year} · ${r.company.name} (${r.company.taxId}) · importes brutos anuales equiparados a jornada completa`],
      header,
    ];
    for (const g of [...r.groups, r.overall]) {
      for (const c of CONCEPTS) {
        const w = g.women[c];
        const m = g.men[c];
        const gapMean = m.mean && w.mean !== null ? ((m.mean - w.mean) / m.mean) * 100 : null;
        const gapMedian = m.median && w.median !== null ? ((m.median - w.median) / m.median) * 100 : null;
        lines.push([g.group, CONCEPT_LABEL[c], w.n, fmt(w.mean), fmt(w.median), m.n, fmt(m.mean), fmt(m.median), fmt(gapMean), fmt(gapMedian)]);
      }
    }
    return toCsv(lines);
  }
}
