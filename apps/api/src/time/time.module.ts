import { Module } from '@nestjs/common';
import { KioskController } from './kiosk.controller';
import { KioskService } from './kiosk.service';
import { SealScheduler } from './seal.scheduler';
import { TimeController } from './time.controller';
import { TimeService } from './time.service';

@Module({ controllers: [TimeController, KioskController], providers: [TimeService, KioskService, SealScheduler], exports: [TimeService, SealScheduler] })
export class TimeModule {}
