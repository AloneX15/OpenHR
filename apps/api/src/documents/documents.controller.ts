import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { loadActor } from '../common/access';
import { CurrentUser, parse, SessionUser, zPeriod, zUuid } from '../common/http';
import { Db } from '../db/db.service';
import { DocumentsService, MAX_UPLOAD_BYTES } from './documents.service';

export function sendFile(res: Response, data: Buffer, filename: string, contentType: string, inline = false) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', data.length);
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(data);
}

const upload = FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } });

@Controller()
export class DocumentsController {
  constructor(
    private readonly db: Db,
    private readonly docs: DocumentsService,
  ) {}

  @Get('documents/mine')
  mine(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.docs.mine(tx, await loadActor(tx)));
  }

  @Get('documents/person/:personId')
  ofPerson(@CurrentUser() u: SessionUser, @Param('personId', ParseUUIDPipe) personId: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.docs.ofPerson(tx, await loadActor(tx), personId));
  }

  @Get('documents/:id/download')
  async download(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { file, data } = await this.db.tx(u.tenantId, u.userId, async (tx) => this.docs.download(tx, await loadActor(tx), id));
    sendFile(res, data, file.filename, file.content_type);
  }

  @Post('documents')
  @UseInterceptors(upload)
  uploadDocument(@CurrentUser() u: SessionUser, @Body() body: unknown, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Falta el fichero');
    const input = parse(
      z.object({
        personId: zUuid,
        companyId: zUuid,
        category: z.enum(['payslip', 'contract', 'certificate', 'other']),
        title: z.string().trim().min(1),
        period: zPeriod.optional(),
      }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.docs.upload(tx, await loadActor(tx), input, file));
  }

  // ── Nóminas ─────────────────────────────────────────────────────────────────────
  @Get('payslips/batches')
  batches(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.docs.listBatches(tx, await loadActor(tx)));
  }

  @Post('payslips/batches')
  @UseInterceptors(upload)
  createBatch(@CurrentUser() u: SessionUser, @Body() body: unknown, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Falta el PDF');
    const input = parse(z.object({ companyId: zUuid, period: zPeriod }), body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.docs.createBatch(tx, await loadActor(tx), input, file));
  }

  @Get('payslips/batches/:id')
  batch(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.docs.getBatch(tx, await loadActor(tx), id));
  }

  @Get('payslips/batches/:id/pages/:n/pdf')
  async page(
    @CurrentUser() u: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('n', ParseIntPipe) n: number,
    @Res() res: Response,
  ) {
    const pdf = await this.db.tx(u.tenantId, u.userId, async (tx) => this.docs.pagePdf(tx, await loadActor(tx), id, n));
    sendFile(res, pdf, `pagina-${n}.pdf`, 'application/pdf', true);
  }

  @Post('payslips/batches/:id/pages/:pageId')
  review(
    @CurrentUser() u: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @Body() body: unknown,
  ) {
    const input = parse(
      z.object({ status: z.enum(['confirmed', 'skipped', 'pending']), personId: zUuid.nullish() }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.docs.reviewPage(tx, await loadActor(tx), id, pageId, input));
  }

  @Post('payslips/batches/:id/confirm-suggestions')
  confirmSuggestions(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.docs.confirmSuggestions(tx, await loadActor(tx), id));
  }

  @Post('payslips/batches/:id/publish')
  publish(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.docs.publish(tx, await loadActor(tx), id));
  }

  @Post('payslips/batches/:id/discard')
  discard(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.docs.discard(tx, await loadActor(tx), id));
  }
}
