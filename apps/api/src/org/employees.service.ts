import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { Actor, assertHr, audit, EmploymentAccess, hrCompanyFilter } from '../common/access';
import { ChecklistsService } from './checklists.service';
import { CustomFieldsService, visibleFields } from './custom-fields.service';
import { zDate, zUuid } from '../common/http';
import { isValidNationalId, normalizeNationalId } from '../common/spanish-id';
import { addDays } from '../common/dates';
import { Tx } from '../db/db.service';
import { AuthService } from '../auth/auth.service';

const zSchedule = z
  .record(z.enum(['1', '2', '3', '4', '5', '6', '7']), z.number().int().min(0).max(24 * 60))
  .refine((s) => Object.keys(s).length === 7, 'La jornada debe indicar los 7 días');

export const employeeInput = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  nationalId: z
    .string()
    .trim()
    .transform(normalizeNationalId)
    .refine(isValidNationalId, 'DNI/NIE no válido')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('').transform(() => undefined)),
  phone: z.string().trim().optional(),
  companyId: zUuid,
  workCenterId: zUuid.nullish(),
  departmentId: zUuid.nullish(),
  managerEmploymentId: zUuid.nullish(),
  employeeNumber: z.string().trim().optional(),
  jobTitle: z.string().trim().optional(),
  contractType: z.string().trim().optional(),
  startDate: zDate,
  weeklyMinutes: z.number().int().min(0).max(60 * 60).optional(),
  schedule: zSchedule.optional(),
  vacationDaysPerYear: z.number().min(0).max(60).optional(),
  sex: z.enum(['female', 'male', 'other']).nullish(),
  professionalGroup: z.string().trim().max(100).nullish(),
  createAccount: z.boolean().default(true),
});
export type EmployeeInput = z.infer<typeof employeeInput>;

export const employeeUpdate = z.object({
  firstName: z.string().trim().min(1).optional(),
  lastName: z.string().trim().min(1).optional(),
  nationalId: z.string().trim().transform(normalizeNationalId).refine(isValidNationalId, 'DNI/NIE no válido').optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  phone: z.string().trim().optional(),
  workCenterId: zUuid.nullish(),
  departmentId: zUuid.nullish(),
  managerEmploymentId: zUuid.nullish(),
  employeeNumber: z.string().trim().nullish(),
  jobTitle: z.string().trim().nullish(),
  contractType: z.string().trim().nullish(),
  weeklyMinutes: z.number().int().min(0).max(60 * 60).optional(),
  schedule: zSchedule.optional(),
  vacationDaysPerYear: z.number().min(0).max(60).optional(),
  hourBankEnabled: z.boolean().optional(),
  hourBankStart: zDate.nullish(),
  sex: z.enum(['female', 'male', 'other']).nullish(),
  professionalGroup: z.string().trim().max(100).nullish(),
});

/** Jornada semanal repartida de lunes a viernes. */
export function weekdaySchedule(weeklyMinutes: number): Record<string, number> {
  const perDay = Math.round(weeklyMinutes / 5);
  return { '1': perDay, '2': perDay, '3': perDay, '4': perDay, '5': perDay, '6': 0, '7': 0 };
}

@Injectable()
export class EmployeesService {
  constructor(
    private readonly auth: AuthService,
    private readonly checklists: ChecklistsService,
    private readonly customFields: CustomFieldsService,
  ) {}

  async list(tx: Tx, actor: Actor, opts: { companyId?: string; q?: string; includeInactive?: boolean }) {
    const companies = hrCompanyFilter(actor);
    const params: unknown[] = [];
    const where: string[] = [];
    // RR. HH. ve sus sociedades; un responsable, a sus reportes directos.
    if (companies !== null) {
      params.push(companies, actor.employments.map((e) => e.id));
      where.push('(e.company_id = ANY($1::uuid[]) OR e.manager_employment_id = ANY($2::uuid[]))');
    }
    if (opts.companyId) {
      params.push(opts.companyId);
      where.push(`e.company_id = $${params.length}`);
    }
    if (!opts.includeInactive) where.push('(e.end_date IS NULL OR e.end_date >= current_date)');
    if (opts.q) {
      params.push(`%${opts.q.toLowerCase()}%`);
      where.push(
        `(lower(p.first_name || ' ' || p.last_name) LIKE $${params.length} OR lower(coalesce(p.national_id,'')) LIKE $${params.length} OR lower(coalesce(p.email,'')) LIKE $${params.length})`,
      );
    }
    return tx.query(
      `SELECT e.id, e.person_id, p.first_name, p.last_name, p.email, p.national_id,
              e.company_id, c.name AS company_name, e.work_center_id, wc.name AS work_center_name,
              e.department_id, d.name AS department_name, e.job_title, e.start_date, e.end_date,
              e.manager_employment_id, mp.first_name || ' ' || mp.last_name AS manager_name,
              u.id AS user_id, u.is_active AS user_active, (u.password_hash IS NOT NULL) AS user_activated
         FROM employment e
         JOIN person p ON p.id = e.person_id
         JOIN company c ON c.id = e.company_id
         LEFT JOIN work_center wc ON wc.id = e.work_center_id
         LEFT JOIN department d ON d.id = e.department_id
         LEFT JOIN employment m ON m.id = e.manager_employment_id
         LEFT JOIN person mp ON mp.id = m.person_id
         LEFT JOIN app_user u ON u.person_id = p.id
        WHERE ${['true', ...where].join(' AND ')}
        ORDER BY p.last_name, p.first_name
        LIMIT 1000`,
      params,
    );
  }

  async get(tx: Tx, employmentId: string, access: EmploymentAccess) {
    const includeSensitive = access === 'self' || access === 'hr';
    const row = await tx.maybeOne(
      `SELECT e.*, p.first_name, p.last_name, p.email, p.phone, p.national_id, p.birth_date, p.sex,
              p.custom_values AS person_custom_values,
              c.name AS company_name, wc.name AS work_center_name, coalesce(wc.timezone, 'Europe/Madrid') AS timezone,
              d.name AS department_name, mp.first_name || ' ' || mp.last_name AS manager_name,
              u.id AS user_id, u.is_active AS user_active, (u.password_hash IS NOT NULL) AS user_activated
         FROM employment e
         JOIN person p ON p.id = e.person_id
         JOIN company c ON c.id = e.company_id
         LEFT JOIN work_center wc ON wc.id = e.work_center_id
         LEFT JOIN department d ON d.id = e.department_id
         LEFT JOIN employment m ON m.id = e.manager_employment_id
         LEFT JOIN person mp ON mp.id = m.person_id
         LEFT JOIN app_user u ON u.person_id = p.id
        WHERE e.id = $1`,
      [employmentId],
    );
    if (!row) throw new NotFoundException('Relación laboral no encontrada');
    delete row.time_chain_head;
    if (!includeSensitive) {
      delete row.national_id;
      delete row.birth_date;
      delete row.phone;
    }
    if (access !== 'hr' && access !== 'self') {
      // Dato necesario para el registro retributivo: solo RR. HH. y la propia persona.
      delete row.sex;
    }
    if (row.user_id) {
      row.roles = await tx.query('SELECT role, company_id FROM role_assignment WHERE user_id = $1', [row.user_id]);
    }
    // Campos personalizados que esta persona puede ver, con sus valores.
    const fields = visibleFields(await this.customFields.list(tx), access);
    row.custom_fields = fields.map((f) => ({
      ...f,
      value: (f.entity === 'person' ? row.person_custom_values : row.custom_values)?.[f.key] ?? null,
    }));
    delete row.person_custom_values;
    delete row.custom_values;
    return row;
  }

  private async assertBelongsToCompany(tx: Tx, table: 'work_center' | 'department', id: string | null | undefined, companyId: string) {
    if (!id) return;
    const row = await tx.maybeOne(`SELECT company_id FROM ${table} WHERE id = $1`, [id]);
    if (!row || row.company_id !== companyId) {
      throw new BadRequestException(table === 'work_center' ? 'El centro no es de esa sociedad' : 'El departamento no es de esa sociedad');
    }
  }

  async create(tx: Tx, actor: Actor, input: EmployeeInput) {
    assertHr(actor, input.companyId);
    await this.assertBelongsToCompany(tx, 'work_center', input.workCenterId, input.companyId);
    await this.assertBelongsToCompany(tx, 'department', input.departmentId, input.companyId);
    if (input.managerEmploymentId) {
      const m = await tx.maybeOne('SELECT id FROM employment WHERE id = $1', [input.managerEmploymentId]);
      if (!m) throw new BadRequestException('Responsable no encontrado');
    }

    // Una persona puede tener varias relaciones laborales en el grupo: se reutiliza por DNI/NIE.
    let person = input.nationalId
      ? await tx.maybeOne('SELECT id, email FROM person WHERE national_id = $1', [input.nationalId])
      : null;
    if (!person && input.email) {
      // Sin DNI coincidente, una persona con el mismo email también es la misma persona.
      // Solo si el DNI/NIE no lo contradice: dos DNI distintos son dos personas distintas.
      person = await tx.maybeOne(
        `SELECT p.id, p.email FROM person p LEFT JOIN app_user u ON u.person_id = p.id
          WHERE (lower(p.email) = lower($1) OR lower(u.email) = lower($1))
            AND (p.national_id IS NULL OR $2::text IS NULL OR p.national_id = $2)
          LIMIT 1`,
        [input.email, input.nationalId ?? null],
      );
      if (person && input.nationalId) {
        await tx.query('UPDATE person SET national_id = coalesce(national_id, $2) WHERE id = $1', [person.id, input.nationalId]);
      }
    }
    if (!person) {
      person = await tx.one(
        `INSERT INTO person (tenant_id, first_name, last_name, national_id, email, phone, sex)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, email`,
        [tx.tenantId, input.firstName, input.lastName, input.nationalId ?? null, input.email ?? null, input.phone ?? null, input.sex ?? null],
      );
    }
    const overlap = await tx.maybeOne(
      `SELECT id FROM employment WHERE person_id = $1 AND company_id = $2
          AND (end_date IS NULL OR end_date >= $3::date)`,
      [person.id, input.companyId, input.startDate],
    );
    if (overlap) throw new ConflictException('Esta persona ya tiene una relación laboral vigente en esa sociedad');

    const weekly = input.weeklyMinutes ?? 2400;
    const employment = await tx.one(
      `INSERT INTO employment (tenant_id, person_id, company_id, work_center_id, department_id, manager_employment_id,
                               employee_number, job_title, contract_type, start_date, weekly_minutes, schedule,
                               vacation_days_per_year, professional_group)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [
        tx.tenantId,
        person.id,
        input.companyId,
        input.workCenterId ?? null,
        input.departmentId ?? null,
        input.managerEmploymentId ?? null,
        input.employeeNumber ?? null,
        input.jobTitle ?? null,
        input.contractType ?? null,
        input.startDate,
        weekly,
        JSON.stringify(input.schedule ?? weekdaySchedule(weekly)),
        input.vacationDaysPerYear ?? 22,
        input.professionalGroup ?? null,
      ],
    );

    let invited = false;
    const email = input.email ?? person.email;
    if (input.createAccount && email) {
      const existing = await tx.maybeOne('SELECT id FROM app_user WHERE person_id = $1', [person.id]);
      if (!existing) {
        const user = await tx.one(
          `INSERT INTO app_user (tenant_id, person_id, email) VALUES ($1, $2, $3) RETURNING id`,
          [tx.tenantId, person.id, email],
        );
        await this.auth.sendInvitation(tx, user.id);
        invited = true;
      }
    }
    await this.checklists.startFor(tx, employment.id, 'onboarding', input.startDate);
    await audit(tx, 'employee.created', 'employment', employment.id, { companyId: input.companyId });
    return { employmentId: employment.id, personId: person.id, invited };
  }

  async update(tx: Tx, actor: Actor, employmentId: string, input: z.infer<typeof employeeUpdate>) {
    const emp = await tx.maybeOne('SELECT company_id, person_id FROM employment WHERE id = $1', [employmentId]);
    if (!emp) throw new NotFoundException();
    assertHr(actor, emp.company_id);
    await this.assertBelongsToCompany(tx, 'work_center', input.workCenterId, emp.company_id);
    await this.assertBelongsToCompany(tx, 'department', input.departmentId, emp.company_id);
    if (input.managerEmploymentId === employmentId) throw new BadRequestException('Nadie puede ser su propio responsable');

    const personFields: Record<string, unknown> = {
      first_name: input.firstName,
      last_name: input.lastName,
      national_id: input.nationalId,
      email: input.email,
      phone: input.phone,
      sex: input.sex,
    };
    const empFields: Record<string, unknown> = {
      work_center_id: input.workCenterId,
      department_id: input.departmentId,
      manager_employment_id: input.managerEmploymentId,
      employee_number: input.employeeNumber,
      job_title: input.jobTitle,
      contract_type: input.contractType,
      weekly_minutes: input.weeklyMinutes,
      schedule: input.schedule ? JSON.stringify(input.schedule) : undefined,
      vacation_days_per_year: input.vacationDaysPerYear,
      hour_bank_enabled: input.hourBankEnabled,
      hour_bank_start: input.hourBankStart,
      professional_group: input.professionalGroup,
    };
    await updateColumns(tx, 'person', emp.person_id, personFields);
    await updateColumns(tx, 'employment', employmentId, empFields);
    if (input.email) {
      await tx.query('UPDATE app_user SET email = $2 WHERE person_id = $1', [emp.person_id, input.email]);
    }
    await audit(tx, 'employee.updated', 'employment', employmentId, {
      fields: Object.keys({ ...personFields, ...empFields }).filter(
        (k) => (personFields as any)[k] !== undefined || (empFields as any)[k] !== undefined,
      ),
    });
  }

  async terminate(tx: Tx, actor: Actor, employmentId: string, endDate: string) {
    const emp = await tx.maybeOne('SELECT company_id, person_id, start_date FROM employment WHERE id = $1', [employmentId]);
    if (!emp) throw new NotFoundException();
    assertHr(actor, emp.company_id);
    await tx.query('UPDATE employment SET end_date = $2 WHERE id = $1', [employmentId, endDate]);
    // Si la persona ya no tiene ninguna relación vigente, su cuenta se desactiva al llegar la fecha.
    // (En el MVP se desactiva ya si la fecha es hoy o anterior.)
    const stillActive = await tx.maybeOne(
      `SELECT 1 FROM employment WHERE person_id = $1 AND (end_date IS NULL OR end_date >= current_date)`,
      [emp.person_id],
    );
    if (!stillActive) await tx.query('UPDATE app_user SET is_active = false WHERE person_id = $1', [emp.person_id]);
    await this.checklists.startFor(tx, employmentId, 'offboarding', endDate);
    await audit(tx, 'employee.terminated', 'employment', employmentId, { endDate });
  }

  /**
   * Traspaso entre sociedades del grupo: cierra la relación laboral el día anterior a la
   * fecha efectiva y abre otra en la sociedad de destino con los mismos datos de jornada.
   * El registro de jornada y las ausencias de cada sociedad quedan en su relación laboral.
   */
  async transfer(
    tx: Tx,
    actor: Actor,
    employmentId: string,
    input: { companyId: string; effectiveDate: string; workCenterId?: string | null; departmentId?: string | null; managerEmploymentId?: string | null; jobTitle?: string | null },
  ) {
    const from = await tx.maybeOne('SELECT * FROM employment WHERE id = $1 FOR UPDATE', [employmentId]);
    if (!from) throw new NotFoundException();
    assertHr(actor, from.company_id);
    assertHr(actor, input.companyId);
    if (input.companyId === from.company_id) throw new BadRequestException('El traspaso es a otra sociedad; para cambiar de centro o puesto, edita la ficha');
    if (from.end_date && from.end_date < input.effectiveDate) throw new BadRequestException('La relación laboral ya había terminado');
    if (input.effectiveDate <= from.start_date) throw new BadRequestException('La fecha del traspaso debe ser posterior al alta');
    await this.assertBelongsToCompany(tx, 'work_center', input.workCenterId, input.companyId);
    await this.assertBelongsToCompany(tx, 'department', input.departmentId, input.companyId);
    const endDate = addDays(input.effectiveDate, -1);
    await tx.query('UPDATE employment SET end_date = $2 WHERE id = $1', [employmentId, endDate]);
    const created = await tx.one(
      `INSERT INTO employment (tenant_id, person_id, company_id, work_center_id, department_id, manager_employment_id, employee_number,
                               job_title, contract_type, start_date, weekly_minutes, schedule, vacation_days_per_year,
                               transferred_from_employment_id, custom_values)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        tx.tenantId,
        from.person_id,
        input.companyId,
        input.workCenterId ?? null,
        input.departmentId ?? null,
        input.managerEmploymentId ?? null,
        input.jobTitle === undefined ? from.job_title : input.jobTitle,
        from.contract_type,
        input.effectiveDate,
        from.weekly_minutes,
        JSON.stringify(from.schedule),
        from.vacation_days_per_year,
        employmentId,
        JSON.stringify(from.custom_values ?? {}),
      ],
    );
    // Las personas que dependían de esta relación laboral pasan a depender de la nueva.
    await tx.query('UPDATE employment SET manager_employment_id = $2 WHERE manager_employment_id = $1 AND (end_date IS NULL OR end_date >= $3)', [
      employmentId,
      created.id,
      input.effectiveDate,
    ]);
    await this.checklists.startFor(tx, created.id, 'transfer', input.effectiveDate);
    await audit(tx, 'employee.transferred', 'employment', employmentId, { to: created.id, ...input });
    return { employmentId: created.id };
  }

  async setRoles(tx: Tx, userId: string, roles: { admin: boolean; hrAll: boolean; hrCompanyIds: string[]; compliance?: boolean }) {
    await tx.query('DELETE FROM role_assignment WHERE user_id = $1', [userId]);
    if (roles.admin) {
      await tx.query(`INSERT INTO role_assignment (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [tx.tenantId, userId]);
    }
    if (roles.compliance) {
      await tx.query(`INSERT INTO role_assignment (tenant_id, user_id, role) VALUES ($1, $2, 'compliance')`, [tx.tenantId, userId]);
    }
    if (roles.hrAll) {
      await tx.query(`INSERT INTO role_assignment (tenant_id, user_id, role) VALUES ($1, $2, 'hr')`, [tx.tenantId, userId]);
    } else {
      for (const c of new Set(roles.hrCompanyIds)) {
        await tx.query(
          `INSERT INTO role_assignment (tenant_id, user_id, role, company_id) VALUES ($1, $2, 'hr', $3)`,
          [tx.tenantId, userId, c],
        );
      }
    }
    await audit(tx, 'user.roles_changed', 'app_user', userId, roles);
  }
}

/** UPDATE solo de las columnas con valor definido (null sí se escribe). */
export async function updateColumns(tx: Tx, table: string, id: string, fields: Record<string, unknown>) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  await tx.query(`UPDATE ${table} SET ${sets} WHERE id = $1`, [id, ...entries.map(([, v]) => v)]);
}
