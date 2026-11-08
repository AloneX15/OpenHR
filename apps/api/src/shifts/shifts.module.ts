import { Module } from '@nestjs/common';
import { HourBankService } from '../time/hour-bank.service';
import { ShiftsController } from './shifts.controller';
import { ShiftsService } from './shifts.service';

@Module({ controllers: [ShiftsController], providers: [ShiftsService, HourBankService], exports: [HourBankService] })
export class ShiftsModule {}
