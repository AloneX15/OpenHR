import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { loadActor } from '../common/access';
import { CurrentUser, parse, Public, SessionUser, zUuid } from '../common/http';
import { Db } from '../db/db.service';
import { KioskService } from './kiosk.service';

@Controller('kiosk')
export class KioskController {
  constructor(
    private readonly db: Db,
    private readonly kiosk: KioskService,
  ) {}

  @Get('devices')
  devices(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.kiosk.devices(tx, await loadActor(tx)));
  }

  @Post('devices')
  create(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(z.object({ workCenterId: zUuid, name: z.string().trim().min(1).max(80) }), body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.kiosk.createDevice(tx, await loadActor(tx), input));
  }

  @Delete('devices/:id')
  deactivate(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.kiosk.deactivate(tx, await loadActor(tx), id));
  }

  @Get('me')
  me(@CurrentUser() u: SessionUser, @Query('employmentId') employmentId?: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.kiosk.myCredentials(tx, await loadActor(tx), employmentId || undefined));
  }

  @Put('pin')
  setPin(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const { pin, employmentId } = parse(z.object({ pin: z.string(), employmentId: zUuid.optional() }), body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.kiosk.setPin(tx, await loadActor(tx), pin, employmentId));
  }

  @Get('qr')
  qr(@CurrentUser() u: SessionUser, @Query('employmentId') employmentId?: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.kiosk.qrToken(await loadActor(tx), employmentId || undefined));
  }

  // ── Desde el dispositivo: cabecera x-kiosk-token, sin sesión ──────────────────────────
  @Public()
  @Get('device')
  info(@Headers('x-kiosk-token') token?: string) {
    return this.kiosk.info(token);
  }

  @Public()
  @Post('device/clock')
  clock(@Headers('x-kiosk-token') token: string | undefined, @Body() body: unknown) {
    const input = parse(
      z
        .object({
          code: z.string().regex(/^\d{6}$/).optional(),
          pin: z.string().regex(/^\d{4,6}$/).optional(),
          qr: z.string().max(2000).optional(),
          idempotencyKey: z.string().min(8).max(100),
        })
        .refine((v) => v.qr || (v.code && v.pin), 'Indica tu código y PIN o muestra tu QR'),
      body,
    );
    return this.kiosk.clock(token, input);
  }
}
