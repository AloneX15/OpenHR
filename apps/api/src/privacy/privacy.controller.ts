import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { loadActor } from '../common/access';
import { CurrentUser, parse, Public, SessionUser, zUuid } from '../common/http';
import { Db } from '../db/db.service';
import { sendFile } from '../documents/documents.controller';
import { PrivacyService } from './privacy.service';
import { WB_CATEGORIES, WhistleblowingService } from './whistleblowing.service';

const zDays = z.number().int().min(1).max(36500);

@Controller()
export class PrivacyController {
  constructor(
    private readonly db: Db,
    private readonly privacy: PrivacyService,
    private readonly wb: WhistleblowingService,
  ) {}

  // ── RGPD ─────────────────────────────────────────────────────────────────────────────
  @Get('privacy/my-data')
  async myData(@CurrentUser() u: SessionUser, @Res() res: Response) {
    const data = await this.db.tx(u.tenantId, u.userId, async (tx) => this.privacy.myData(tx, await loadActor(tx)));
    sendFile(res, Buffer.from(JSON.stringify(data, null, 2)), `mis-datos-openhr-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
  }

  @Get('privacy/requests/mine')
  mine(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.privacy.mine(tx, await loadActor(tx)));
  }

  @Post('privacy/requests')
  request(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(
      z.object({ kind: z.enum(['access', 'rectification', 'erasure', 'restriction', 'portability', 'objection']), details: z.string().trim().min(5).max(5000) }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.privacy.request(tx, await loadActor(tx), input));
  }

  @Get('privacy/requests')
  list(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.privacy.list(tx, await loadActor(tx)));
  }

  @Post('privacy/requests/:id')
  respond(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(
      z.object({ status: z.enum(['in_progress', 'completed', 'rejected']), response: z.string().trim().max(5000).optional(), extendDays: z.number().int().min(0).max(60).optional() }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.privacy.respond(tx, await loadActor(tx), id, input));
  }

  @Get('privacy/retention')
  retention(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.privacy.settings(tx));
  }

  @Put('privacy/retention')
  saveRetention(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(
      z.object({ time_entries: zDays.optional(), notifications: zDays.optional(), outbox: zDays.optional(), audit: zDays.optional(), former_employees: zDays.optional() }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.privacy.saveSettings(tx, await loadActor(tx), input));
  }

  @Post('privacy/retention/run')
  run(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const { dryRun } = parse(z.object({ dryRun: z.boolean().default(true) }), body ?? {});
    return this.db.tx(u.tenantId, u.userId, async (tx) => {
      const actor = await loadActor(tx);
      if (!actor.isAdmin) throw new ForbiddenException();
      return this.privacy.run(tx, dryRun, actor.userId);
    });
  }

  @Post('privacy/anonymize/:personId')
  anonymize(@CurrentUser() u: SessionUser, @Param('personId', ParseUUIDPipe) personId: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.privacy.manualAnonymize(tx, await loadActor(tx), personId));
  }

  // ── Canal de denuncias: gestión ──────────────────────────────────────────────────────
  @Get('whistleblowing/settings')
  wbSettings(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.wb.settings(tx, await loadActor(tx)));
  }

  @Post('whistleblowing/enable')
  wbEnable(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const { regenerate } = parse(z.object({ regenerate: z.boolean().default(false) }), body ?? {});
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.wb.enable(tx, await loadActor(tx), regenerate));
  }

  @Get('whistleblowing/reports')
  wbList(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.wb.list(tx, await loadActor(tx)));
  }

  @Get('whistleblowing/reports/:id')
  wbGet(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.wb.get(tx, await loadActor(tx), id));
  }

  @Post('whistleblowing/reports/:id/messages')
  wbReply(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { body: text } = parse(z.object({ body: z.string().trim().min(1).max(10000) }), body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.wb.reply(tx, await loadActor(tx), id, text));
  }

  @Post('whistleblowing/reports/:id/status')
  wbStatus(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(
      z.object({
        status: z.enum(['received', 'acknowledged', 'investigating', 'resolved', 'dismissed']),
        resolution: z.string().trim().max(10000).optional(),
        extendResolution: z.boolean().default(false),
      }),
      body,
    );
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.wb.setStatus(tx, await loadActor(tx), id, input.status, input.resolution, input.extendResolution));
  }

  // ── Canal de denuncias: acceso público, sin sesión ───────────────────────────────────
  @Public()
  @Get('public/whistleblowing/:token')
  publicInfo(@Param('token') token: string, @Req() req: Request) {
    return this.wb.publicInfo(token, req.ip ?? '');
  }

  @Public()
  @Post('public/whistleblowing/:token/reports')
  publicSubmit(@Param('token') token: string, @Body() body: unknown, @Req() req: Request) {
    const input = parse(
      z.object({
        category: z.enum(WB_CATEGORIES),
        subject: z.string().trim().min(3).max(200),
        description: z.string().trim().min(20, 'Describe los hechos con algo más de detalle').max(20000),
        anonymous: z.boolean(),
        contact: z.string().trim().max(500).optional(),
      }),
      body,
    );
    return this.wb.submit(token, req.ip ?? '', input);
  }

  @Public()
  @Post('public/whistleblowing/:token/status')
  publicStatus(@Param('token') token: string, @Body() body: unknown, @Req() req: Request) {
    const { code } = parse(z.object({ code: z.string().trim().min(10).max(40) }), body);
    return this.wb.publicStatus(token, req.ip ?? '', code);
  }

  @Public()
  @Post('public/whistleblowing/:token/messages')
  publicMessage(@Param('token') token: string, @Body() body: unknown, @Req() req: Request) {
    const input = parse(z.object({ code: z.string().trim().min(10).max(40), body: z.string().trim().min(1).max(10000) }), body);
    return this.wb.publicMessage(token, req.ip ?? '', input.code, input.body);
  }
}
