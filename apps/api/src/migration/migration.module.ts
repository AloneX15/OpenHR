import { Module } from '@nestjs/common';
import { TimeModule } from '../time/time.module';
import { FactorialMigrationService } from './factorial-migration.service';
import { MigrationController } from './migration.controller';

@Module({ imports: [TimeModule], controllers: [MigrationController], providers: [FactorialMigrationService], exports: [FactorialMigrationService] })
export class MigrationModule {}
