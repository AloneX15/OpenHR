import { Module } from '@nestjs/common';
import { ImportsService } from '../imports/imports.service';
import { OrgModule } from '../org/org.module';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

@Module({ imports: [OrgModule], controllers: [ExportsController], providers: [ExportsService, ImportsService] })
export class ExportsModule {}
