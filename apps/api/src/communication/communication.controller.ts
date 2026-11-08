import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { loadActor } from '../common/access';
import { CurrentUser, parse, SessionUser, zDate, zUuid } from '../common/http';
import { Db } from '../db/db.service';
import { sendFile } from '../documents/documents.controller';
import { MAX_UPLOAD_BYTES } from '../documents/documents.service';
import { CommunicationService } from './communication.service';
import { SignaturesService } from './signatures.service';

const upload = FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } });
const zBool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);
const meta = (req: Request) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

@Controller()
export class CommunicationController {
  constructor(
    private readonly db: Db,
    private readonly comm: CommunicationService,
    private readonly signatures: SignaturesService,
  ) {}

  // ── Anuncios ─────────────────────────────────────────────────────────────────────
  @Get('announcements')
  announcements(@CurrentUser() u: SessionUser, @Query('archived') archived?: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.comm.announcements(tx, await loadActor(tx), archived === 'true'));
  }

  @Post('announcements')
  publish(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(
      z.object({
        companyId: zUuid.nullable().default(null),
        title: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(20000),
        pinned: z.boolean().default(false),
        expiresAt: zDate.optional(),
        notify: z.boolean().default(true),
      }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.comm.publishAnnouncement(tx, await loadActor(tx), input));
  }

  @Patch('announcements/:id')
  updateAnnouncement(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(
      z.object({
        title: z.string().trim().min(1).max(200).optional(),
        body: z.string().trim().min(1).max(20000).optional(),
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
        expiresAt: zDate.nullish(),
      }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.comm.updateAnnouncement(tx, await loadActor(tx), id, input));
  }

  @Post('announcements/:id/read')
  read(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.comm.markRead(tx, await loadActor(tx), id));
  }

  // ── Políticas ────────────────────────────────────────────────────────────────────
  @Get('policies')
  policies(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.comm.policies(tx, await loadActor(tx)));
  }

  @Post('policies')
  @UseInterceptors(upload)
  publishPolicy(@CurrentUser() u: SessionUser, @Body() body: unknown, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Falta el PDF');
    const input = parse(
      z.object({
        companyId: zUuid.optional().transform((v) => v ?? null),
        seriesId: zUuid.optional(),
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2000).optional(),
        requiresAcceptance: zBool.default(true),
      }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.comm.publishPolicy(tx, await loadActor(tx), input, file));
  }

  @Get('policies/:id/file')
  async policyFile(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { file, data } = await this.db.tx(u.tenantId, u.userId, async (tx) => this.comm.policyFile(tx, await loadActor(tx), id));
    sendFile(res, data, file.filename, 'application/pdf', true);
  }

  @Post('policies/:id/accept')
  accept(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.comm.accept(tx, await loadActor(tx), id, meta(req)));
  }

  @Get('policies/:id/acceptances')
  acceptances(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.comm.acceptances(tx, await loadActor(tx), id));
  }

  // ── Firma ────────────────────────────────────────────────────────────────────────
  @Get('signatures/mine')
  mySignatures(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.signatures.mine(tx, await loadActor(tx)));
  }

  @Get('signatures')
  listSignatures(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.signatures.list(tx, await loadActor(tx)));
  }

  @Post('signatures')
  @UseInterceptors(upload)
  requestSignature(@CurrentUser() u: SessionUser, @Body() body: unknown, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Falta el PDF');
    const input = parse(
      z.object({
        personId: zUuid,
        companyId: zUuid,
        title: z.string().trim().min(1).max(200),
        message: z.string().trim().max(2000).optional(),
        dueDate: zDate.optional(),
      }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.signatures.request(tx, await loadActor(tx), input, file));
  }

  @Get('signatures/:id/file')
  async signatureFile(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Query('signed') signed: string, @Res() res: Response) {
    const { file, data } = await this.db.tx(u.tenantId, u.userId, async (tx) => this.signatures.file(tx, await loadActor(tx), id, signed === 'true'));
    sendFile(res, data, file.filename, 'application/pdf', true);
  }

  @Get('signatures/:id/evidence')
  evidence(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.signatures.evidence(tx, await loadActor(tx), id));
  }

  @Post('signatures/:id/code')
  sendCode(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.signatures.sendCode(tx, await loadActor(tx), id));
  }

  @Post('signatures/:id/sign')
  async sign(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const { code } = parse(
      z.object({ code: z.string().regex(/^\s*\d{6}\s*$/, 'Código de 6 dígitos'), consent: z.literal(true, { message: 'Debes aceptar la declaración' }) }),
      body,
    );
    const result = await this.db.tx(u.tenantId, u.userId, async (tx) => this.signatures.sign(tx, await loadActor(tx), id, code, meta(req)));
    // El intento fallido ya se ha guardado (la transacción se confirmó): ahora se responde el error.
    if (!result.ok) throw new BadRequestException('Código incorrecto');
    return result;
  }

  @Post('signatures/:id/decline')
  decline(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3) }), body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.signatures.decline(tx, await loadActor(tx), id, reason));
  }

  @Post('signatures/:id/cancel')
  cancel(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.signatures.cancel(tx, await loadActor(tx), id));
  }
}
