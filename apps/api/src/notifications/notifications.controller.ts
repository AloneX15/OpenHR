import { Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentUser, SessionUser } from '../common/http';
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

  @Post('read-all')
  async readAll(@CurrentUser() u: SessionUser) {
    await this.db.tx(u.tenantId, u.userId, (tx) =>
      tx.query('UPDATE notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [u.userId]),
    );
    return { ok: true };
  }
}
