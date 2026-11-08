import { Module } from '@nestjs/common';
import { AbsencesController } from './absences.controller';
import { AbsencesService } from './absences.service';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';

@Module({
  controllers: [AbsencesController, ApprovalsController],
  providers: [AbsencesService, ApprovalsService],
  exports: [AbsencesService, ApprovalsService],
})
export class AbsencesModule {}
