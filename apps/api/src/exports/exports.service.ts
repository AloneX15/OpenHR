import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Actor, assertEmploymentAccess, assertHr, audit } from '../common/access';
import { expectedMinutes, isEmployed, isWorkingDay, loadCalendars } from '../common/calendar';
import { sha256 } from '../common/crypto';
import { monthRange, zonedToUtc } from '../common/dates';
import { Tx } from '../db/db.service';
import { dailySummaries, StoredEntry } from '../time/worktime';

/** CSV para Excel en español: separador «;», BOM UTF-8 y CRLF. */
export function toCsv(rows: (string | number | null | undefined)[][]): Buffer {
  const esc = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    // Evita inyección de fórmulas al abrir en hojas de cálculo.
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s) ? `'${s}` : s;
    return /[";\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const body = rows.map((r) => r.map(esc).join(';')).join('\r\n') + '\r\n';
  return Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(body, 'utf8')]);
}

export function hhmm(minutes: number): string {
  const sign = minutes < 0 ? '-' : '';
  const m = Math.abs(Math.round(minutes));
  return `${sign}${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

const decimal = (n: number) => n.toFixed(2).replace('.', ',');

interface ExportFile {
  filename: string;
  data: Buffer;
  sha256: string;
}

@Injectable()
export class ExportsService {
  private async employmentsFor(tx: Tx, companyId: string | null, employmentId: string | null, from: string, to: string) {
    return tx.query(
      `SELECT e.id, e.employee_number, p.first_name, p.last_name, p.national_id, c.name AS company_name, c.tax_id,
              wc.name AS work_center_name, e.company_id
         FROM employment e JOIN person p ON p.id = e.person_id JOIN company c ON c.id = e.company_id
         LEFT JOIN work_center wc ON wc.id = e.work_center_id
        WHERE ($1::uuid IS NULL OR e.company_id = $1) AND ($2::uuid IS NULL OR e.id = $2)
          AND e.start_date <= $4 AND (e.end_date IS NULL OR e.end_date >= $3)
        ORDER BY p.last_name, p.first_name, e.start_date`,
      [companyId, employmentId, from, to],
    );
  }

  /**
   * Registro diario de jornada (art. 34.9 ET): inicio y fin de cada jornada, por persona
   * y día, con las correcciones identificadas. Disponible para la empresa, la persona
   * trabajadora, sus representantes y la Inspección de Trabajo.
   */
  async timeRegister(
    tx: Tx,
    actor: Actor,
    q: { companyId?: string; employmentId?: string; from: string; to: string },
  ): Promise<ExportFile> {
    if (q.employmentId) await assertEmploymentAccess(tx, actor, q.employmentId, ['self', 'hr']);
    else if (q.companyId) assertHr(actor, q.companyId);
    else throw new BadRequestException('Indica una sociedad o una persona');

    const emps = await this.employmentsFor(tx, q.companyId ?? null, q.employmentId ?? null, q.from, q.to);
    if (!emps.length) throw new NotFoundException('No hay personas con alta en ese periodo');
    const cals = await loadCalendars(tx, emps.map((e) => e.id), q.from, q.to);

    const rows: (string | number | null)[][] = [
      [
        'CIF', 'Sociedad', 'Centro', 'Nº empleado', 'Apellidos', 'Nombre', 'DNI/NIE', 'Fecha', 'Primera entrada',
        'Última salida', 'Tramos de trabajo', 'Tiempo trabajado', 'Pausas', 'Jornada teórica', 'Diferencia',
        'Festivo', 'Ausencia', 'Fichajes manuales', 'Anulaciones', 'Incidencias',
      ],
    ];
    for (const e of emps) {
      const cal = cals.get(e.id)!;
      const start = zonedToUtc(q.from, '00:00', cal.timezone);
      const end = new Date(zonedToUtc(q.to, '23:59', cal.timezone).getTime() + 60_000);
      const entries = await tx.query<StoredEntry>(
        `SELECT * FROM time_entry WHERE employment_id = $1 AND (
            (kind <> 'void' AND occurred_at >= $2 AND occurred_at < $3)
            OR (kind = 'void' AND voids_entry_id IN (SELECT id FROM time_entry WHERE employment_id = $1 AND occurred_at >= $2 AND occurred_at < $3)))`,
        [e.id, start, end],
      );
      const manualByDay = new Map<string, number>();
      const voidByDay = new Map<string, number>();
      const days = dailySummaries(entries, cal.timezone, q.from, q.to);
      const dayOf = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: cal.timezone }).format(d);
      const byId = new Map(entries.map((x) => [x.id, x]));
      for (const x of entries) {
        if (x.kind === 'void') {
          const target = byId.get(x.voids_entry_id!);
          if (target) voidByDay.set(dayOf(target.occurred_at), (voidByDay.get(dayOf(target.occurred_at)) ?? 0) + 1);
        } else if (x.source !== 'clock') {
          manualByDay.set(dayOf(x.occurred_at), (manualByDay.get(dayOf(x.occurred_at)) ?? 0) + 1);
        }
      }
      for (const d of days) {
        if (!isEmployed(cal, d.date)) continue;
        const expected = expectedMinutes(cal, d.date);
        rows.push([
          e.tax_id,
          e.company_name,
          e.work_center_name,
          e.employee_number,
          e.last_name,
          e.first_name,
          e.national_id,
          d.date,
          d.firstIn,
          d.lastOut,
          d.segments.join(' '),
          hhmm(d.workedMinutes),
          hhmm(d.breakMinutes),
          hhmm(expected),
          hhmm(d.workedMinutes - expected),
          cal.holidays.get(d.date) ?? '',
          cal.absences.get(d.date)?.name ?? '',
          manualByDay.get(d.date) ?? 0,
          voidByDay.get(d.date) ?? 0,
          d.incidents.join(' | '),
        ]);
      }
    }
    const data = toCsv(rows);
    const scope = q.employmentId ? `persona-${emps[0].last_name}` : emps[0].tax_id;
    const filename = `registro-jornada_${scope}_${q.from}_${q.to}.csv`.replace(/[^\w.-]+/g, '-');
    const digest = sha256(data);
    await audit(tx, 'export.time_register', q.employmentId ? 'employment' : 'company', q.employmentId ?? q.companyId!, {
      from: q.from,
      to: q.to,
      sha256: digest,
    });
    return { filename, data, sha256: digest };
  }

  /** Variables de nómina del mes para la gestoría: días, horas y ausencias por persona. */
  async payrollVariables(tx: Tx, actor: Actor, q: { companyId: string; period: string }): Promise<ExportFile> {
    assertHr(actor, q.companyId);
    const { from, to } = monthRange(q.period);
    const emps = await this.employmentsFor(tx, q.companyId, null, from, to);
    if (!emps.length) throw new NotFoundException('No hay personas con alta en ese periodo');
    const cals = await loadCalendars(tx, emps.map((e) => e.id), from, to);
    const types = await tx.query('SELECT id, code, name FROM absence_type ORDER BY code');

    const header = [
      'CIF', 'Sociedad', 'Nº empleado', 'Apellidos', 'Nombre', 'DNI/NIE', 'Periodo', 'Alta desde', 'Alta hasta',
      'Días naturales de alta', 'Días laborables teóricos', 'Horas teóricas', 'Horas trabajadas', 'Diferencia (horas)',
      'Días con ausencia retribuida', 'Días con ausencia no retribuida',
      ...types.map((t) => `${t.code} (días)`),
    ];
    const rows: (string | number | null)[][] = [header];
    for (const e of emps) {
      const cal = cals.get(e.id)!;
      const start = zonedToUtc(from, '00:00', cal.timezone);
      const end = new Date(zonedToUtc(to, '23:59', cal.timezone).getTime() + 60_000);
      const entries = await tx.query<StoredEntry>(
        `SELECT * FROM time_entry WHERE employment_id = $1 AND (
            (kind <> 'void' AND occurred_at >= $2 AND occurred_at < $3)
            OR (kind = 'void' AND voids_entry_id IN (SELECT id FROM time_entry WHERE employment_id = $1 AND occurred_at >= $2 AND occurred_at < $3)))`,
        [e.id, start, end],
      );
      const days = dailySummaries(entries, cal.timezone, from, to);
      let employedDays = 0;
      let workingDays = 0;
      let expected = 0;
      let worked = 0;
      let paidAbs = 0;
      let unpaidAbs = 0;
      const perType = new Map<string, number>();
      for (const d of days) {
        if (!isEmployed(cal, d.date)) continue;
        employedDays++;
        if (isWorkingDay(cal, d.date)) workingDays++;
        expected += expectedMinutes(cal, d.date);
        worked += d.workedMinutes;
        const abs = cal.absences.get(d.date);
        if (abs) {
          perType.set(abs.typeId, (perType.get(abs.typeId) ?? 0) + 1);
          if (abs.paid) paidAbs++;
          else unpaidAbs++;
        }
      }
      rows.push([
        e.tax_id,
        e.company_name,
        e.employee_number,
        e.last_name,
        e.first_name,
        e.national_id,
        q.period,
        cal.startDate > from ? cal.startDate : from,
        cal.endDate && cal.endDate < to ? cal.endDate : to,
        employedDays,
        workingDays,
        decimal(expected / 60),
        decimal(worked / 60),
        decimal((worked - expected) / 60),
        paidAbs,
        unpaidAbs,
        ...types.map((t) => perType.get(t.id) ?? 0),
      ]);
    }
    const data = toCsv(rows);
    const filename = `variables-nomina_${emps[0].tax_id}_${q.period}.csv`;
    const digest = sha256(data);
    await audit(tx, 'export.payroll_variables', 'company', q.companyId, { period: q.period, sha256: digest });
    return { filename, data, sha256: digest };
  }

}
