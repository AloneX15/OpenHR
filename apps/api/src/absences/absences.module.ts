import { Module } from '@nestjs/common';
import { AbsencesController } from './absences.controller';
import { AbsencesService } from './absences.service';

@Module({ controllers: [AbsencesController], providers: [AbsencesService], exports: [AbsencesService] })
export class AbsencesModule {}
