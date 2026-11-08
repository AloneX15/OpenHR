import { Controller, Get, Module } from '@nestjs/common';
import { AbsencesModule } from './absences/absences.module';
import { AuthModule } from './auth/auth.module';
import { Public } from './common/http';
import { Db } from './db/db.service';
import { DbModule } from './db/db.module';
import { DocumentsModule } from './documents/documents.module';
import { ExportsModule } from './exports/exports.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OrgModule } from './org/org.module';
import { ShiftsModule } from './shifts/shifts.module';
import { TimeModule } from './time/time.module';

@Controller()
class HealthController {
  constructor(private readonly db: Db) {}

  @Public()
  @Get('health')
  async health() {
    await this.db.raw('SELECT 1');
    return { status: 'ok' };
  }
}

@Module({
  imports: [DbModule, NotificationsModule, AuthModule, OrgModule, TimeModule, AbsencesModule, DocumentsModule, ExportsModule, ShiftsModule],
  controllers: [HealthController],
})
export class AppModule {}
