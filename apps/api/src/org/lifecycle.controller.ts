import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { loadActor } from '../common/access';
import { CurrentUser, parse, SessionUser, zDate, zUuid } from '../common/http';
import { Db } from '../db/db.service';
import { ChecklistsService } from './checklists.service';
import { CustomFieldsService } from './custom-fields.service';
import { EmployeesService } from './employees.service';

const zKind = z.enum(['onboarding', 'offboarding', 'transfer']);
const zTemplate = z.object({
  companyId: zUuid.nullable().default(null),
  kind: zKind,
  name: z.string().trim().min(1),
  active: z.boolean().default(true),
  items: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        description: z.string().trim().max(2000).optional(),
        assignee: z.enum(['hr', 'manager', 'employee']),
        dueOffsetDays: z.number().int().min(-90).max(365).default(0),
      }),
    )
    .min(1)
    .max(100),
});
const zField = z.object({
  entity: z.enum(['person', 'employment']),
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Clave en minúsculas, sin espacios (p. ej. talla_camiseta)'),
  label: z.string().trim().min(1),
  type: z.enum(['text', 'number', 'date', 'boolean', 'select']),
  options: z.array(z.string().trim().min(1)).max(100).default([]),
  required: z.boolean().default(false),
  visibility: z.enum(['hr', 'manager', 'employee']).default('hr'),
  position: z.number().int().default(0),
  active: z.boolean().default(true),
});

/** Ciclo de vida (altas, bajas, traspasos) y campos personalizados. */
@Controller()
export class LifecycleController {
  constructor(
    private readonly db: Db,
    private readonly checklists: ChecklistsService,
    private readonly customFields: CustomFieldsService,
    private readonly employees: EmployeesService,
  ) {}

  @Get('checklists/templates')
  templates(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, (tx) => this.checklists.templates(tx));
  }

  @Post('checklists/templates')
  createTemplate(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(zTemplate, body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.checklists.saveTemplate(tx, await loadActor(tx), null, input));
  }

  @Put('checklists/templates/:id')
  updateTemplate(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(zTemplate, body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.checklists.saveTemplate(tx, await loadActor(tx), id, input));
  }

  @Get('checklists/tasks')
  myTasks(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.checklists.myTasks(tx, await loadActor(tx)));
  }

  @Post('checklists/tasks/:id')
  setTask(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { done, note } = parse(z.object({ done: z.boolean(), note: z.string().trim().max(1000).optional() }), body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.checklists.setTask(tx, await loadActor(tx), id, done, note));
  }

  @Get('org/employees/:id/checklists')
  employeeChecklists(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.checklists.forEmployment(tx, await loadActor(tx), id));
  }

  @Post('org/employees/:id/checklists')
  startChecklist(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(z.object({ templateId: zUuid, referenceDate: zDate }), body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.checklists.startManually(tx, await loadActor(tx), id, input.templateId, input.referenceDate));
  }

  @Post('org/employees/:id/transfer')
  transfer(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(
      z.object({
        companyId: zUuid,
        effectiveDate: zDate,
        workCenterId: zUuid.nullish(),
        departmentId: zUuid.nullish(),
        managerEmploymentId: zUuid.nullish(),
        jobTitle: z.string().trim().nullish(),
      }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.employees.transfer(tx, await loadActor(tx), id, input));
  }

  @Get('org/custom-fields')
  fields(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, (tx) => this.customFields.list(tx));
  }

  @Post('org/custom-fields')
  createField(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(zField, body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.customFields.save(tx, await loadActor(tx), null, input));
  }

  @Patch('org/custom-fields/:id')
  updateField(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(zField, body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.customFields.save(tx, await loadActor(tx), id, input));
  }

  @Put('org/employees/:id/custom-values')
  setValues(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(z.object({ person: z.record(z.string(), z.unknown()).optional(), employment: z.record(z.string(), z.unknown()).optional() }), body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.customFields.setValues(tx, await loadActor(tx), id, input));
  }
}
