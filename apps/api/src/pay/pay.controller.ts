import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { loadActor } from '../common/access';
import { CurrentUser, parse, SessionUser, zDate, zUuid } from '../common/http';
import { Db } from '../db/db.service';
import { sendFile } from '../documents/documents.controller';
import { PayService } from './pay.service';

const zRegister = z.object({
  companyId: zUuid,
  year: z.coerce.number().int().min(2000).max(2100),
  groupBy: z.enum(['professional_group', 'job_title']).default('professional_group'),
});

@Controller('pay')
export class PayController {
  constructor(
    private readonly db: Db,
    private readonly pay: PayService,
  ) {}

  @Get('compensation/:employmentId')
  history(@CurrentUser() u: SessionUser, @Param('employmentId', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.pay.history(tx, await loadActor(tx), id));
  }

  @Post('compensation')
  add(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(
      z.object({
        employmentId: zUuid,
        effectiveFrom: zDate,
        baseAnnual: z.number().min(0).max(10_000_000),
        complementsAnnual: z.number().min(0).max(10_000_000).default(0),
        extraSalaryAnnual: z.number().min(0).max(10_000_000).default(0),
        note: z.string().trim().max(500).optional(),
      }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.pay.add(tx, await loadActor(tx), input));
  }

  @Delete('compensation/:id')
  remove(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.pay.remove(tx, await loadActor(tx), id));
  }

  @Get('register')
  register(@CurrentUser() u: SessionUser, @Query() query: Record<string, string>) {
    const q = parse(zRegister, query);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.pay.register(tx, await loadActor(tx), q.companyId, q.year, q.groupBy));
  }

  @Get('register.csv')
  async registerCsv(@CurrentUser() u: SessionUser, @Query() query: Record<string, string>, @Res() res: Response) {
    const q = parse(zRegister, query);
    const r = await this.db.tx(u.tenantId, u.userId, async (tx) => this.pay.register(tx, await loadActor(tx), q.companyId, q.year, q.groupBy));
    sendFile(res, this.pay.registerCsv(r), `registro-retributivo_${r.company.taxId}_${r.year}.csv`, 'text/csv; charset=utf-8');
  }
}
