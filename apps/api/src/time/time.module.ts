import { Module } from '@nestjs/common';
import { KioskController } from './kiosk.controller';
import { KioskService } from './kiosk.service';
import { TimeController } from './time.controller';
import { TimeService } from './time.service';

@Module({ controllers: [TimeController, KioskController], providers: [TimeService, KioskService], exports: [TimeService] })
export class TimeModule {}
