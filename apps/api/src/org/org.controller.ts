import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { assertAdmin, assertEmploymentAccess, assertHr, audit, loadActor } from '../common/access';
import { CurrentUser, parse, SessionUser, zDate, zUuid } from '../common/http';
import { Db, Tx } from '../db/db.service';
import { AuthService } from '../auth/auth.service';
import { addNationalHolidays } from './defaults';
import { employeeInput, employeeUpdate, EmployeesService, updateColumns } from './employees.service';

const companyInput = z.object({
  name: z.string().trim().min(1),
  legalName: z.string().trim().min(1),
  taxId: z.string().trim().toUpperCase().min(8).max(12),
  ccc: z.string().trim().optional(),
  address: z.string().trim().optional(),
});

const timezones = new Set(Intl.supportedValuesOf('timeZone'));
const centerInput = z.object({
  companyId: zUuid,
  name: z.string().trim().min(1),
  timezone: z.string().refine((tz) => timezones.has(tz) || tz === 'UTC', 'Zona horaria no válida').default('Europe/Madrid'),
  region: z.string().trim().optional(),
  address: z.string().trim().optional(),
});

@Controller('org')
export class OrgController {
  constructor(
    private readonly db: Db,
    private readonly employees: EmployeesService,
    private readonly auth: AuthService,
  ) {}

  private run<T>(u: SessionUser, fn: (tx: Tx) => Promise<T>) {
    return this.db.tx<T>(u.tenantId, u.userId, fn);
  }

  // ── Sociedades ─────────────────────────────────────────────────────────────────
  @Get('companies')
  companies(@CurrentUser() u: SessionUser) {
    return this.run(u, (tx) => tx.query('SELECT * FROM company ORDER BY name'));
  }

  @Post('companies')
  createCompany(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(companyInput, body);
    return this.run(u, async (tx) => {
      assertAdmin(await loadActor(tx));
      const c = await tx.one(
        `INSERT INTO company (tenant_id, name, legal_name, tax_id, ccc, address) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [tx.tenantId, input.name, input.legalName, input.taxId, input.ccc ?? null, input.address ?? null],
      );
      await tx.query(`INSERT INTO work_center (tenant_id, company_id, name) VALUES ($1, $2, 'Sede central')`, [tx.tenantId, c.id]);
      await audit(tx, 'company.created', 'company', c.id, input);
      return c;
    });
  }

  @Patch('companies/:id')
  updateCompany(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(companyInput.partial(), body);
    return this.run(u, async (tx) => {
      assertAdmin(await loadActor(tx));
      await updateColumns(tx, 'company', id, {
        name: input.name,
        legal_name: input.legalName,
        tax_id: input.taxId,
        ccc: input.ccc,
        address: input.address,
      });
      await audit(tx, 'company.updated', 'company', id, input);
      return tx.one('SELECT * FROM company WHERE id = $1', [id]);
    });
  }

  // ── Centros y departamentos ─────────────────────────────────────────────────────
  @Get('work-centers')
  workCenters(@CurrentUser() u: SessionUser, @Query('companyId') companyId?: string) {
    return this.run(u, (tx) =>
      tx.query(
        `SELECT wc.*, c.name AS company_name FROM work_center wc JOIN company c ON c.id = wc.company_id
          WHERE ($1::uuid IS NULL OR wc.company_id = $1) ORDER BY c.name, wc.name`,
        [companyId || null],
      ),
    );
  }

  @Post('work-centers')
  createWorkCenter(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(centerInput, body);
    return this.run(u, async (tx) => {
      assertHr(await loadActor(tx), input.companyId);
      return tx.one(
        `INSERT INTO work_center (tenant_id, company_id, name, timezone, region, address)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [tx.tenantId, input.companyId, input.name, input.timezone, input.region ?? null, input.address ?? null],
      );
    });
  }

  @Patch('work-centers/:id')
  updateWorkCenter(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(centerInput.omit({ companyId: true }).partial(), body);
    return this.run(u, async (tx) => {
      const wc = await tx.maybeOne('SELECT company_id FROM work_center WHERE id = $1', [id]);
      if (!wc) throw new NotFoundException();
      assertHr(await loadActor(tx), wc.company_id);
      await updateColumns(tx, 'work_center', id, input);
      return tx.one('SELECT * FROM work_center WHERE id = $1', [id]);
    });
  }

  @Get('departments')
  departments(@CurrentUser() u: SessionUser, @Query('companyId') companyId?: string) {
    return this.run(u, (tx) =>
      tx.query(
        `SELECT d.*, c.name AS company_name FROM department d JOIN company c ON c.id = d.company_id
          WHERE ($1::uuid IS NULL OR d.company_id = $1) ORDER BY c.name, d.name`,
        [companyId || null],
      ),
    );
  }

  @Post('departments')
  createDepartment(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(z.object({ companyId: zUuid, name: z.string().trim().min(1) }), body);
    return this.run(u, async (tx) => {
      assertHr(await loadActor(tx), input.companyId);
      return tx.one(`INSERT INTO department (tenant_id, company_id, name) VALUES ($1,$2,$3) RETURNING *`, [
        tx.tenantId,
        input.companyId,
        input.name,
      ]);
    });
  }

  // ── Festivos ────────────────────────────────────────────────────────────────────
  @Get('holidays')
  holidays(@CurrentUser() u: SessionUser, @Query('year') year?: string) {
    const y = Number(year) || new Date().getUTCFullYear();
    return this.run(u, (tx) =>
      tx.query(
        `SELECT h.*, c.name AS company_name, wc.name AS work_center_name FROM holiday h
           LEFT JOIN company c ON c.id = h.company_id
           LEFT JOIN work_center wc ON wc.id = h.work_center_id
          WHERE h.date BETWEEN make_date($1, 1, 1) AND make_date($1, 12, 31)
          ORDER BY h.date`,
        [y],
      ),
    );
  }

  @Post('holidays')
  createHoliday(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(
      z.object({ date: zDate, name: z.string().trim().min(1), companyId: zUuid.nullish(), workCenterId: zUuid.nullish() }),
      body,
    );
    return this.run(u, async (tx) => {
      const actor = await loadActor(tx);
      let companyId = input.companyId ?? null;
      if (input.workCenterId) {
        const wc = await tx.maybeOne('SELECT company_id FROM work_center WHERE id = $1', [input.workCenterId]);
        if (!wc) throw new NotFoundException('Centro no encontrado');
        companyId = wc.company_id;
      }
      if (companyId) assertHr(actor, companyId);
      else assertAdmin(actor);
      return tx.one(
        `INSERT INTO holiday (tenant_id, company_id, work_center_id, date, name) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [tx.tenantId, companyId, input.workCenterId ?? null, input.date, input.name],
      );
    });
  }

  @Post('holidays/national/:year')
  addNational(@CurrentUser() u: SessionUser, @Param('year') year: string) {
    const y = parse(z.coerce.number().int().min(2000).max(2100), year);
    return this.run(u, async (tx) => {
      assertAdmin(await loadActor(tx));
      await addNationalHolidays(tx, y);
      return { ok: true };
    });
  }

  @Delete('holidays/:id')
  deleteHoliday(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.run(u, async (tx) => {
      const h = await tx.maybeOne('SELECT company_id FROM holiday WHERE id = $1', [id]);
      if (!h) throw new NotFoundException();
      const actor = await loadActor(tx);
      if (h.company_id) assertHr(actor, h.company_id);
      else assertAdmin(actor);
      await tx.query('DELETE FROM holiday WHERE id = $1', [id]);
      return { ok: true };
    });
  }

  // ── Tipos de ausencia ───────────────────────────────────────────────────────────
  @Get('absence-types')
  absenceTypes(@CurrentUser() u: SessionUser) {
    return this.run(u, (tx) => tx.query('SELECT * FROM absence_type ORDER BY active DESC, name'));
  }

  @Post('absence-types')
  createAbsenceType(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(absenceTypeInput, body);
    return this.run(u, async (tx) => {
      assertAdmin(await loadActor(tx));
      return tx.one(
        `INSERT INTO absence_type (tenant_id, code, name, paid, counts_as_vacation, requires_approval, day_unit, sensitive, consumes_hour_bank)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [tx.tenantId, input.code, input.name, input.paid, input.countsAsVacation, input.requiresApproval, input.dayUnit, input.sensitive, input.consumesHourBank],
      );
    });
  }

  @Patch('absence-types/:id')
  updateAbsenceType(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(absenceTypeInput.partial().extend({ active: z.boolean().optional() }), body);
    return this.run(u, async (tx) => {
      assertAdmin(await loadActor(tx));
      await updateColumns(tx, 'absence_type', id, {
        code: input.code,
        name: input.name,
        paid: input.paid,
        counts_as_vacation: input.countsAsVacation,
        requires_approval: input.requiresApproval,
        day_unit: input.dayUnit,
        sensitive: input.sensitive,
        consumes_hour_bank: input.consumesHourBank,
        active: input.active,
      });
      return tx.one('SELECT * FROM absence_type WHERE id = $1', [id]);
    });
  }

  // ── Personas ────────────────────────────────────────────────────────────────────
  @Get('employees')
  listEmployees(
    @CurrentUser() u: SessionUser,
    @Query('companyId') companyId?: string,
    @Query('q') q?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.run(u, async (tx) => {
      const actor = await loadActor(tx);
      return this.employees.list(tx, actor, {
        companyId: companyId ? parse(zUuid, companyId) : undefined,
        q,
        includeInactive: includeInactive === 'true',
      });
    });
  }

  @Get('employees/:id')
  getEmployee(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.run(u, async (tx) => {
      const actor = await loadActor(tx);
      const access = await assertEmploymentAccess(tx, actor, id);
      return this.employees.get(tx, id, access);
    });
  }

  @Post('employees')
  createEmployee(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(employeeInput, body);
    return this.run(u, async (tx) => this.employees.create(tx, await loadActor(tx), input));
  }

  @Patch('employees/:id')
  updateEmployee(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(employeeUpdate, body);
    return this.run(u, async (tx) => {
      await this.employees.update(tx, await loadActor(tx), id, input);
      return { ok: true };
    });
  }

  @Post('employees/:id/terminate')
  terminate(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { endDate } = parse(z.object({ endDate: zDate }), body);
    return this.run(u, async (tx) => {
      await this.employees.terminate(tx, await loadActor(tx), id, endDate);
      return { ok: true };
    });
  }

  @Post('employees/:id/invite')
  invite(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email().optional() }), body ?? {});
    return this.run(u, async (tx) => {
      const actor = await loadActor(tx);
      const emp = await tx.maybeOne(
        `SELECT e.company_id, e.person_id, p.email FROM employment e JOIN person p ON p.id = e.person_id WHERE e.id = $1`,
        [id],
      );
      if (!emp) throw new NotFoundException();
      assertHr(actor, emp.company_id);
      let user = await tx.maybeOne('SELECT id, password_hash FROM app_user WHERE person_id = $1', [emp.person_id]);
      const address = email ?? emp.email;
      if (!user) {
        if (!address) throw new ForbiddenException('La persona no tiene email');
        user = await tx.one(`INSERT INTO app_user (tenant_id, person_id, email) VALUES ($1,$2,$3) RETURNING id`, [
          tx.tenantId,
          emp.person_id,
          address,
        ]);
      }
      await this.auth.sendInvitation(tx, user.id);
      return { ok: true };
    });
  }

  @Put('users/:userId/roles')
  setRoles(@CurrentUser() u: SessionUser, @Param('userId', ParseUUIDPipe) userId: string, @Body() body: unknown) {
    const roles = parse(
      z.object({ admin: z.boolean(), hrAll: z.boolean(), hrCompanyIds: z.array(zUuid).default([]) }),
      body,
    );
    return this.run(u, async (tx) => {
      assertAdmin(await loadActor(tx));
      if (userId === u.userId && !roles.admin) {
        const others = await tx.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM role_assignment WHERE role = 'admin' AND user_id <> $1`,
          [userId],
        );
        if (others.n === 0) throw new ForbiddenException('Debe quedar al menos una persona administradora');
      }
      await this.employees.setRoles(tx, userId, roles);
      return { ok: true };
    });
  }

  @Get('audit')
  auditLog(@CurrentUser() u: SessionUser, @Query('entity') entity?: string, @Query('entityId') entityId?: string) {
    return this.run(u, async (tx) => {
      // El registro de auditoría abarca todas las sociedades: solo administración.
      assertAdmin(await loadActor(tx));
      return tx.query(
        `SELECT a.*, coalesce(p.first_name || ' ' || p.last_name, us.email) AS actor_name
           FROM audit_event a
           LEFT JOIN app_user us ON us.id = a.actor_id
           LEFT JOIN person p ON p.id = us.person_id
          WHERE ($1::text IS NULL OR a.entity = $1) AND ($2::text IS NULL OR a.entity_id = $2)
          ORDER BY a.id DESC LIMIT 200`,
        [entity || null, entityId || null],
      );
    });
  }
}

const absenceTypeInput = z.object({
  code: z.string().trim().toUpperCase().min(1).max(10),
  name: z.string().trim().min(1),
  paid: z.boolean().default(true),
  countsAsVacation: z.boolean().default(false),
  requiresApproval: z.boolean().default(true),
  dayUnit: z.enum(['working', 'calendar']).default('working'),
  sensitive: z.boolean().default(false),
  consumesHourBank: z.boolean().default(false),
});
