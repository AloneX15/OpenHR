import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { loadActor } from '../common/access';
import { CurrentUser, parse, SessionUser, zDate, zUuid } from '../common/http';
import { Db } from '../db/db.service';
import { AbsencesService } from './absences.service';

@Controller('absences')
export class AbsencesController {
  constructor(
    private readonly db: Db,
    private readonly absences: AbsencesService,
  ) {}

  @Get('mine')
  mine(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.absences.mine(tx, await loadActor(tx)));
  }

  @Get('pending')
  pending(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.absences.pendingForMe(tx, await loadActor(tx)));
  }

  @Get('team')
  team(@CurrentUser() u: SessionUser, @Query('from') from: string, @Query('to') to: string) {
    const q = parse(z.object({ from: zDate, to: zDate }), { from, to });
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.absences.team(tx, await loadActor(tx), q.from, q.to));
  }

  @Get('balance/:employmentId')
  balance(@CurrentUser() u: SessionUser, @Param('employmentId', ParseUUIDPipe) id: string, @Query('year') year?: string) {
    const y = Number(year) || new Date().getUTCFullYear();
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.absences.balance(tx, await loadActor(tx), id, y));
  }

  @Post()
  request(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(
      z.object({
        employmentId: zUuid.optional(),
        absenceTypeId: zUuid,
        startDate: zDate,
        endDate: zDate,
        comment: z.string().trim().max(1000).optional(),
      }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.absences.request(tx, await loadActor(tx), input));
  }

  @Post(':id/approve')
  approve(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { comment } = parse(z.object({ comment: z.string().trim().max(1000).optional() }), body ?? {});
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.absences.decide(tx, await loadActor(tx), id, true, comment));
  }

  @Post(':id/reject')
  reject(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { comment } = parse(z.object({ comment: z.string().trim().max(1000).optional() }), body ?? {});
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.absences.decide(tx, await loadActor(tx), id, false, comment));
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.absences.cancel(tx, await loadActor(tx), id));
  }

  @Post('adjustments')
  adjust(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(
      z.object({ employmentId: zUuid, year: z.number().int(), days: z.number(), reason: z.string().trim().min(3) }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.absences.addAdjustment(tx, await loadActor(tx), input));
  }
}
