import { BadRequestException, Injectable } from '@nestjs/common';
import { parse as parseCsv } from 'csv-parse/sync';
import { Actor, canHr } from '../common/access';
import { isValidNationalId, normalizeNationalId } from '../common/spanish-id';
import { Tx } from '../db/db.service';
import { EmployeesService } from '../org/employees.service';

export const IMPORT_COLUMNS = [
  'nombre', 'apellidos', 'dni', 'email', 'telefono', 'cif_sociedad', 'centro', 'departamento', 'puesto',
  'tipo_contrato', 'fecha_alta', 'horas_semanales', 'dias_vacaciones', 'numero_empleado', 'dni_responsable',
] as const;

type Row = Record<(typeof IMPORT_COLUMNS)[number], string>;

export interface ImportLine {
  line: number;
  name: string;
  errors: string[];
  warnings: string[];
}

/** Acepta AAAA-MM-DD o DD/MM/AAAA. */
export function parseDate(value: string): string | null {
  const v = value.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  let iso: string | null = null;
  if (m) iso = `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (m) iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

export function parseEmployeeCsv(data: Buffer): Row[] {
  const text = data.toString('utf8').replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const records: Record<string, string>[] = parseCsv(text, {
    delimiter,
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_')),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
  if (!records.length) throw new BadRequestException('El fichero no tiene filas');
  const missing = ['nombre', 'apellidos', 'cif_sociedad', 'fecha_alta'].filter((c) => !(c in records[0]));
  if (missing.length) throw new BadRequestException(`Faltan columnas obligatorias: ${missing.join(', ')}`);
  return records.map((r) => Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, r[c] ?? ''])) as Row);
}

@Injectable()
export class ImportsService {
  constructor(private readonly employees: EmployeesService) {}

  /**
   * Importa personas y relaciones laborales. Primero valida todo; si hay errores no se
   * escribe nada (dryRun o no). La importación es atómica: o entran todas o ninguna.
   */
  async importEmployees(tx: Tx, actor: Actor, data: Buffer, dryRun: boolean) {
    const rows = parseEmployeeCsv(data);
    if (rows.length > 5000) throw new BadRequestException('Máximo 5000 filas por importación');
    const companies = await tx.query('SELECT id, tax_id FROM company');
    const companyByCif = new Map(companies.map((c) => [c.tax_id.toUpperCase(), c.id]));
    const centers = await tx.query('SELECT id, company_id, lower(name) AS name FROM work_center');
    const departments = await tx.query('SELECT id, company_id, lower(name) AS name FROM department');
    const existingPeople = await tx.query('SELECT national_id FROM person WHERE national_id IS NOT NULL');
    const known = new Set(existingPeople.map((p) => p.national_id));
    const inFile = new Set<string>();
    const emails = new Set((await tx.query('SELECT lower(email) AS email FROM app_user')).map((u) => u.email));

    const report: ImportLine[] = [];
    const valid: { row: Row; companyId: string; startDate: string; nationalId?: string }[] = [];
    rows.forEach((row, i) => {
      const line: ImportLine = { line: i + 2, name: `${row.nombre} ${row.apellidos}`.trim(), errors: [], warnings: [] };
      if (!row.nombre) line.errors.push('Falta el nombre');
      if (!row.apellidos) line.errors.push('Faltan los apellidos');
      const companyId = companyByCif.get(row.cif_sociedad.toUpperCase());
      if (!companyId) line.errors.push(`No existe la sociedad con CIF ${row.cif_sociedad || '(vacío)'}`);
      else if (!canHr(actor, companyId)) line.errors.push('No tienes permisos de RR. HH. en esa sociedad');
      const startDate = parseDate(row.fecha_alta);
      if (!startDate) line.errors.push(`Fecha de alta no válida: «${row.fecha_alta}»`);
      let nationalId: string | undefined;
      if (row.dni) {
        nationalId = normalizeNationalId(row.dni);
        if (!isValidNationalId(nationalId)) line.errors.push(`DNI/NIE no válido: ${row.dni}`);
        else if (inFile.has(nationalId)) line.errors.push('DNI/NIE repetido en el fichero');
        else {
          inFile.add(nationalId);
          if (known.has(nationalId)) line.warnings.push('La persona ya existe: se le añadirá una relación laboral');
        }
      } else {
        line.warnings.push('Sin DNI/NIE: no se podrá asignar su nómina automáticamente');
      }
      if (row.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) line.errors.push(`Email no válido: ${row.email}`);
      else if (row.email && emails.has(row.email.toLowerCase()) && !known.has(nationalId ?? '')) {
        line.errors.push('Ese email ya lo usa otra cuenta');
      } else if (row.email) emails.add(row.email.toLowerCase());
      if (!row.email) line.warnings.push('Sin email: no tendrá acceso a la aplicación');
      if (row.horas_semanales && !(Number(row.horas_semanales.replace(',', '.')) >= 0)) line.errors.push('Horas semanales no válidas');
      if (row.dias_vacaciones && !(Number(row.dias_vacaciones.replace(',', '.')) >= 0)) line.errors.push('Días de vacaciones no válidos');
      if (row.dni_responsable && !isValidNationalId(row.dni_responsable)) line.errors.push('DNI del responsable no válido');
      if (companyId && row.centro && !centers.some((c) => c.company_id === companyId && c.name === row.centro.toLowerCase())) {
        line.warnings.push(`Se creará el centro «${row.centro}»`);
      }
      if (companyId && row.departamento && !departments.some((d) => d.company_id === companyId && d.name === row.departamento.toLowerCase())) {
        line.warnings.push(`Se creará el departamento «${row.departamento}»`);
      }
      report.push(line);
      if (!line.errors.length) valid.push({ row, companyId: companyId!, startDate: startDate!, nationalId });
    });
    // Responsables: deben existir ya o venir en el mismo fichero.
    for (const v of valid) {
      const boss = v.row.dni_responsable ? normalizeNationalId(v.row.dni_responsable) : null;
      if (boss && !known.has(boss) && !inFile.has(boss)) {
        report.find((l) => l.line === rows.indexOf(v.row) + 2)!.errors.push('El responsable no existe ni está en el fichero');
      }
    }
    const errorCount = report.filter((l) => l.errors.length).length;
    if (dryRun || errorCount) return { dryRun: true, total: rows.length, errors: errorCount, report };

    const created: { employmentId: string; nationalId?: string; boss: string | null; companyId: string }[] = [];
    for (const v of valid) {
      const { row } = v;
      const centerId = row.centro ? await this.findOrCreate(tx, 'work_center', v.companyId, row.centro) : null;
      const departmentId = row.departamento ? await this.findOrCreate(tx, 'department', v.companyId, row.departamento) : null;
      const r = await this.employees.create(tx, actor, {
        firstName: row.nombre,
        lastName: row.apellidos,
        nationalId: v.nationalId,
        email: row.email ? row.email.toLowerCase() : undefined,
        phone: row.telefono || undefined,
        companyId: v.companyId,
        workCenterId: centerId,
        departmentId,
        managerEmploymentId: null,
        employeeNumber: row.numero_empleado || undefined,
        jobTitle: row.puesto || undefined,
        contractType: row.tipo_contrato || undefined,
        startDate: v.startDate,
        weeklyMinutes: row.horas_semanales ? Math.round(Number(row.horas_semanales.replace(',', '.')) * 60) : undefined,
        vacationDaysPerYear: row.dias_vacaciones ? Number(row.dias_vacaciones.replace(',', '.')) : undefined,
        createAccount: Boolean(row.email),
      });
      created.push({
        employmentId: r.employmentId,
        nationalId: v.nationalId,
        boss: row.dni_responsable ? normalizeNationalId(row.dni_responsable) : null,
        companyId: v.companyId,
      });
    }
    // Segunda pasada: responsables (preferimos su relación laboral en la misma sociedad).
    for (const c of created.filter((x) => x.boss)) {
      const boss = await tx.maybeOne(
        `SELECT e.id FROM employment e JOIN person p ON p.id = e.person_id
          WHERE p.national_id = $1 AND (e.end_date IS NULL OR e.end_date >= current_date)
          ORDER BY (e.company_id = $2) DESC, e.start_date DESC LIMIT 1`,
        [c.boss, c.companyId],
      );
      if (boss) await tx.query('UPDATE employment SET manager_employment_id = $2 WHERE id = $1', [c.employmentId, boss.id]);
    }
    return { dryRun: false, total: rows.length, errors: 0, created: created.length, report };
  }

  private async findOrCreate(tx: Tx, table: 'work_center' | 'department', companyId: string, name: string): Promise<string> {
    const found = await tx.maybeOne(`SELECT id FROM ${table} WHERE company_id = $1 AND lower(name) = lower($2)`, [companyId, name]);
    if (found) return found.id;
    const row = await tx.one(`INSERT INTO ${table} (tenant_id, company_id, name) VALUES ($1, $2, $3) RETURNING id`, [
      tx.tenantId,
      companyId,
      name,
    ]);
    return row.id;
  }
}
