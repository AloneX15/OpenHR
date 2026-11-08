import { BadRequestException, Body, Controller, Delete, Get, Headers, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { config } from '../config';
import { CurrentUser, parse, SessionUser } from '../common/http';
import { allowedPushEndpoint, pushEnabled } from './notifications.service';
import { Db } from '../db/db.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly db: Db) {}

  @Get()
  list(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, (tx) =>
      tx.query(
        `SELECT id, type, title, body, link, read_at, created_at FROM notification
          WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [u.userId],
      ),
    );
  }

  @Post(':id/read')
  async read(@CurrentUser() u: SessionUser, @Param('id') id: string) {
    await this.db.tx(u.tenantId, u.userId, (tx) =>
      tx.query('UPDATE notification SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL', [
        id,
        u.userId,
      ]),
    );
    return { ok: true };
  }

  // ── Avisos push ───────────────────────────────────────────────────────────────
  @Get('push')
  async push(@CurrentUser() u: SessionUser) {
    const devices = await this.db.tx(u.tenantId, u.userId, (tx) =>
      tx.query('SELECT id, user_agent, created_at, last_used_at FROM push_subscription WHERE user_id = $1 ORDER BY created_at', [u.userId]),
    );
    return { enabled: pushEnabled(), publicKey: pushEnabled() ? config.push.publicKey : null, devices };
  }

  @Post('push/subscriptions')
  async subscribe(@CurrentUser() u: SessionUser, @Body() body: unknown, @Headers('user-agent') ua?: string) {
    if (!pushEnabled()) throw new BadRequestException('Los avisos push no están configurados en este servidor');
    const input = parse(
      z.object({
        endpoint: z.string().url().max(2000),
        keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
      }),
      body,
    );
    if (!allowedPushEndpoint(input.endpoint)) throw new BadRequestException('Servicio de push no admitido');
    return this.db.tx(u.tenantId, u.userId, async (tx) => {
      // El endpoint es único: si el navegador ya estaba suscrito con otra cuenta, se borra la anterior.
      await tx.query('DELETE FROM push_subscription WHERE endpoint = $1', [input.endpoint]);
      return tx.one(
        `INSERT INTO push_subscription (tenant_id, user_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [u.tenantId, u.userId, input.endpoint, input.keys.p256dh, input.keys.auth, ua?.slice(0, 300) ?? null],
      );
    });
  }

  @Delete('push/subscriptions')
  async unsubscribe(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const { endpoint } = parse(z.object({ endpoint: z.string().max(2000).optional() }), body ?? {});
    await this.db.tx(u.tenantId, u.userId, (tx) =>
      tx.query('DELETE FROM push_subscription WHERE user_id = $1 AND ($2::text IS NULL OR endpoint = $2)', [u.userId, endpoint ?? null]),
    );
    return { ok: true };
  }

  @Post('read-all')
  async readAll(@CurrentUser() u: SessionUser) {
    await this.db.tx(u.tenantId, u.userId, (tx) =>
      tx.query('UPDATE notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [u.userId]),
    );
    return { ok: true };
  }
}
