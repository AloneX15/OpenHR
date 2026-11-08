import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { loadActor } from '../common/access';
import { CurrentUser, parse, SessionUser, zDate, zPeriod, zUuid } from '../common/http';
import { Db } from '../db/db.service';
import { sendFile } from '../documents/documents.controller';
import { ExpensesService, MAX_RECEIPT_BYTES } from './expenses.service';

const zCategory = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['amount', 'mileage']).default('amount'),
  rateCentsPerKm: z.coerce.number().int().min(1).max(1000).nullish(),
  limitCents: z.coerce.number().int().min(1).nullish(),
  requiresReceipt: z.boolean().default(true),
  active: z.boolean().default(true),
});

// Los formularios multipart llegan como texto: se convierten aquí.
const zNumberField = z.preprocess((v) => (v === '' || v === undefined || v === null ? undefined : Number(String(v).replace(',', '.'))), z.number().positive().max(100000).optional());

@Controller('expenses')
export class ExpensesController {
  constructor(
    private readonly db: Db,
    private readonly expenses: ExpensesService,
  ) {}

  @Get('categories')
  categories(@CurrentUser() u: SessionUser, @Query('all') all?: string) {
    return this.db.tx(u.tenantId, u.userId, (tx) => this.expenses.categories(tx, all === 'true'));
  }

  @Post('categories')
  createCategory(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(zCategory, body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.expenses.saveCategory(tx, await loadActor(tx), null, input));
  }

  @Patch('categories/:id')
  updateCategory(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(zCategory, body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.expenses.saveCategory(tx, await loadActor(tx), id, input));
  }

  @Get('mine')
  mine(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.expenses.mine(tx, await loadActor(tx)));
  }

  @Get('to-approve')
  toApprove(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.expenses.toApprove(tx, await loadActor(tx)));
  }

  @Get()
  list(@CurrentUser() u: SessionUser, @Query() query: unknown) {
    const f = parse(
      z.object({ status: z.enum(['pending', 'approved', 'rejected', 'paid', 'cancelled']).optional(), companyId: zUuid.optional(), period: zPeriod.optional() }),
      query,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.expenses.list(tx, await loadActor(tx), f));
  }

  @Get('export')
  async export(@CurrentUser() u: SessionUser, @Query() query: unknown, @Res() res: Response) {
    const f = parse(z.object({ status: z.enum(['approved', 'paid']).default('approved'), period: zPeriod.optional(), companyId: zUuid.optional() }), query);
    const csv = await this.db.tx(u.tenantId, u.userId, async (tx) => this.expenses.exportCsv(tx, await loadActor(tx), f));
    sendFile(res, Buffer.from(csv, 'utf8'), `gastos-${f.status}${f.period ? `-${f.period}` : ''}.csv`, 'text/csv; charset=utf-8');
  }

  @Post()
  @UseInterceptors(FileInterceptor('receipt', { limits: { fileSize: MAX_RECEIPT_BYTES } }))
  create(@CurrentUser() u: SessionUser, @Body() body: unknown, @UploadedFile() file?: Express.Multer.File) {
    const input = parse(
      z.object({
        employmentId: zUuid,
        categoryId: zUuid,
        date: zDate,
        description: z.string().trim().min(1).max(500),
        amount: zNumberField,
        km: zNumberField,
      }),
      body,
    );
    if (file && !file.size) throw new BadRequestException('El justificante está vacío');
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.expenses.create(tx, await loadActor(tx), input, file));
  }

  @Get(':id/receipt')
  async receipt(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { file, data } = await this.db.tx(u.tenantId, u.userId, async (tx) => this.expenses.receipt(tx, await loadActor(tx), id));
    sendFile(res, data, file.filename, file.content_type, true);
  }

  @Post(':id/decision')
  decide(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(z.object({ approve: z.boolean(), comment: z.string().trim().max(500).optional() }), body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.expenses.decide(tx, await loadActor(tx), id, input.approve, input.comment));
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.expenses.cancel(tx, await loadActor(tx), id));
  }

  @Post('pay')
  pay(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(z.object({ ids: z.array(zUuid).min(1).max(1000), period: zPeriod }), body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.expenses.markPaid(tx, await loadActor(tx), input.ids, input.period));
  }
}
