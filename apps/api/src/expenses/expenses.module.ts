import { Module } from '@nestjs/common';
import { AbsencesModule } from '../absences/absences.module';
import { DocumentsModule } from '../documents/documents.module';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

@Module({
  imports: [AbsencesModule, DocumentsModule],
  controllers: [ExpensesController],
  providers: [ExpensesService],
})
export class ExpensesModule {}
