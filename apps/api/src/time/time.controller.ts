import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { assertHr, loadActor } from '../common/access';
import { CurrentUser, parse, SessionUser, zDate, zUuid } from '../common/http';
import { Db } from '../db/db.service';
import { TimeService } from './time.service';

const zKind = z.enum(['in', 'out', 'break_start', 'break_end']);

@Controller('time')
export class TimeController {
  constructor(
    private readonly db: Db,
    private readonly time: TimeService,
  ) {}

  /** Estado actual de mis relaciones laborales activas. */
  @Get('status')
  status(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => {
      const actor = await loadActor(tx);
      const out = [];
      for (const e of actor.employments.filter((x) => x.active)) {
        out.push({ employmentId: e.id, ...(await this.time.currentState(tx, e.id)) });
      }
      return out;
    });
  }

  @Post('clock')
  clock(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(
      z.object({
        employmentId: zUuid.optional(),
        kind: zKind.optional(),
        idempotencyKey: z.string().min(8).max(100),
        deviceTime: z.string().datetime({ offset: true }).optional(),
      }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.time.clock(tx, await loadActor(tx), input));
  }

  @Post('entries')
  addManual(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(
      z.object({
        employmentId: zUuid,
        kind: zKind,
        date: zDate,
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora HH:MM'),
        reason: z.string().trim().min(3, 'Indica el motivo'),
      }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.time.addManual(tx, await loadActor(tx), input));
  }

  @Post('entries/:id/void')
  void(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'Indica el motivo') }), body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.time.voidEntry(tx, await loadActor(tx), id, reason));
  }

  @Get('employments/:id')
  range(
    @CurrentUser() u: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const q = parse(
      z.object({ from: zDate, to: zDate }).refine((v) => v.from <= v.to, 'Rango no válido').refine(
        (v) => (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 366,
        'Máximo un año',
      ),
      { from, to },
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.time.range(tx, await loadActor(tx), id, q.from, q.to));
  }

  @Get('employments/:id/verify')
  verify(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.time.verify(tx, await loadActor(tx), id));
  }

  @Get('team')
  team(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.time.teamNow(tx, await loadActor(tx)));
  }

  @Post('seal')
  seal(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const { companyId } = parse(z.object({ companyId: zUuid }), body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.time.seal(tx, await loadActor(tx), companyId));
  }

  @Get('seals')
  seals(@CurrentUser() u: SessionUser, @Query('companyId') companyId: string) {
    const id = parse(zUuid, companyId);
    return this.db.tx(u.tenantId, u.userId, async (tx) => {
      assertHr(await loadActor(tx), id);
      return tx.query('SELECT id, sealed_at, digest, sent_to FROM time_chain_seal WHERE company_id = $1 ORDER BY sealed_at DESC LIMIT 50', [id]);
    });
  }
}
