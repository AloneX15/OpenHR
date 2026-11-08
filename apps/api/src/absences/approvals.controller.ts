import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { loadActor } from '../common/access';
import { CurrentUser, parse, SessionUser, zDate, zUuid } from '../common/http';
import { Db } from '../db/db.service';
import { ApprovalsService } from './approvals.service';

const zStep = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manager') }),
  z.object({ kind: z.literal('manager_of_manager') }),
  z.object({ kind: z.literal('hr') }),
  z.object({ kind: z.literal('admin') }),
  z.object({ kind: z.literal('user'), userId: zUuid }),
]);

@Controller('approvals')
export class ApprovalsController {
  constructor(
    private readonly db: Db,
    private readonly approvals: ApprovalsService,
  ) {}

  @Get('flows')
  flows(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, (tx) => this.approvals.listFlows(tx));
  }

  @Put('flows')
  saveFlow(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(
      z.object({ companyId: zUuid.nullable().default(null), absenceTypeId: zUuid.nullable().default(null), steps: z.array(zStep).min(1).max(5) }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.approvals.saveFlow(tx, await loadActor(tx), input));
  }

  @Delete('flows/:id')
  deleteFlow(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.approvals.deleteFlow(tx, await loadActor(tx), id));
  }

  @Get('delegations')
  delegations(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.approvals.listDelegations(tx, await loadActor(tx)));
  }

  @Post('delegations')
  delegate(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(
      z.object({ toUserId: zUuid, startDate: zDate, endDate: zDate, reason: z.string().trim().max(300).optional(), fromUserId: zUuid.optional() }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.approvals.createDelegation(tx, await loadActor(tx), input));
  }

  @Delete('delegations/:id')
  undelegate(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.approvals.deleteDelegation(tx, await loadActor(tx), id));
  }

  @Get('candidates')
  candidates(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, (tx) => this.approvals.candidates(tx));
  }
}
