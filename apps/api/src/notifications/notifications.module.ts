import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { OutboxWorker } from './outbox.worker';

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, OutboxWorker],
  exports: [NotificationsService, OutboxWorker],
})
export class NotificationsModule {}
