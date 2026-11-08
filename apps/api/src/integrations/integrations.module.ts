import { Body, Controller, Delete, Get, Global, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { assertAdmin, loadActor } from '../common/access';
import { CurrentUser, parse, SessionUser, zUuid } from '../common/http';
import { Db } from '../db/db.service';
import { ChatService } from './chat.service';

const zWebhook = z.object({
  provider: z.enum(['slack', 'teams']),
  label: z.string().trim().min(1).max(80),
  url: z.string().trim().max(2000).optional(),
  companyId: zUuid.nullable().default(null),
  events: z.array(z.enum(['announcement', 'absence', 'welcome'])).min(1),
  enabled: z.boolean().default(true),
});

@Controller('integrations/chat')
export class ChatController {
  constructor(
    private readonly db: Db,
    private readonly chat: ChatService,
  ) {}

  @Get()
  list(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => {
      assertAdmin(await loadActor(tx));
      return this.chat.list(tx);
    });
  }

  @Post()
  create(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(zWebhook, body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.chat.save(tx, await loadActor(tx), null, input));
  }

  @Patch(':id')
  update(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(zWebhook, body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.chat.save(tx, await loadActor(tx), id, input));
  }

  @Delete(':id')
  remove(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.chat.remove(tx, await loadActor(tx), id));
  }

  @Post(':id/test')
  test(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.chat.test(tx, await loadActor(tx), id));
  }
}

/** Integraciones con otros servicios. Global: cualquier módulo puede publicar avisos en los canales. */
@Global()
@Module({
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class IntegrationsModule {}
