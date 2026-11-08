import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { loadActor } from '../common/access';
import { CurrentUser, parse, SessionUser, zDate, zUuid } from '../common/http';
import { Db } from '../db/db.service';
import { HourBankService } from '../time/hour-bank.service';
import { ShiftsService } from './shifts.service';

const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora HH:MM');
const zRange = z
  .object({ from: zDate, to: zDate, companyId: zUuid.optional() })
  .refine((v) => v.from <= v.to, 'Rango no válido')
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 62, 'Máximo dos meses');

@Controller()
export class ShiftsController {
  constructor(
    private readonly db: Db,
    private readonly shifts: ShiftsService,
    private readonly bank: HourBankService,
  ) {}

  @Get('shifts/templates')
  templates(@CurrentUser() u: SessionUser, @Query('companyId') companyId?: string) {
    return this.db.tx(u.tenantId, u.userId, (tx) => this.shifts.templates(tx, companyId ? parse(zUuid, companyId) : undefined));
  }

  @Post('shifts/templates')
  createTemplate(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(
      z.object({
        companyId: zUuid,
        name: z.string().trim().min(1),
        start: zTime,
        end: zTime,
        breakMinutes: z.number().int().min(0).max(240).default(0),
        color: z.enum(['sky', 'navy', 'teal', 'amber', 'violet', 'rose', 'slate']).default('sky'),
      }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.shifts.createTemplate(tx, await loadActor(tx), input));
  }

  @Patch('shifts/templates/:id')
  updateTemplate(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(
      z.object({
        name: z.string().trim().min(1).optional(),
        breakMinutes: z.number().int().min(0).max(240).optional(),
        color: z.enum(['sky', 'navy', 'teal', 'amber', 'violet', 'rose', 'slate']).optional(),
        active: z.boolean().optional(),
      }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.shifts.updateTemplate(tx, await loadActor(tx), id, input));
  }

  /** Cuadrante: personas que puedo planificar, sus turnos (también borradores) e incumplimientos. */
  @Get('shifts')
  planner(@CurrentUser() u: SessionUser, @Query() query: Record<string, string>) {
    const q = parse(zRange, query);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.shifts.planner(tx, await loadActor(tx), q));
  }

  @Get('shifts/mine')
  mine(@CurrentUser() u: SessionUser, @Query() query: Record<string, string>) {
    const q = parse(zRange, query);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.shifts.mine(tx, await loadActor(tx), q.from, q.to));
  }

  @Put('shifts')
  save(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const { items } = parse(
      z.object({
        items: z
          .array(
            z.object({
              employmentId: zUuid,
              date: zDate,
              clear: z.boolean().optional(),
              dayOff: z.boolean().optional(),
              templateId: zUuid.optional(),
              start: zTime.optional(),
              end: zTime.optional(),
              breakMinutes: z.number().int().min(0).max(240).optional(),
              note: z.string().trim().max(500).optional(),
            }),
          )
          .min(1)
          .max(2000),
      }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.shifts.save(tx, await loadActor(tx), items));
  }

  @Post('shifts/publish')
  publish(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const q = parse(zRange, body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.shifts.publish(tx, await loadActor(tx), q));
  }

  @Patch('org/companies/:id/work-rules')
  rules(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const r = parse(
      z.object({
        minRestBetweenShiftsMinutes: z.number().int().min(0).max(24 * 60).optional(),
        maxDailyOrdinaryMinutes: z.number().int().min(60).max(24 * 60).optional(),
        minWeeklyRestMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
        maxYearlyOvertimeMinutes: z.number().int().min(0).max(1000 * 60).optional(),
      }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.shifts.updateRules(tx, await loadActor(tx), id, r));
  }

  // ── Bolsa de horas ────────────────────────────────────────────────────────────────
  @Get('time/employments/:id/hour-bank')
  hourBank(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Query('year') year?: string) {
    const y = Number(year) || new Date().getUTCFullYear();
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.bank.summary(tx, await loadActor(tx), id, y));
  }

  @Post('time/hour-bank/adjustments')
  adjust(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(
      z.object({
        employmentId: zUuid,
        date: zDate,
        minutes: z.number().int().refine((m) => m !== 0, 'No puede ser 0'),
        kind: z.enum(['opening', 'paid', 'adjustment']),
        reason: z.string().trim().min(3),
      }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.bank.adjust(tx, await loadActor(tx), input));
  }
}
