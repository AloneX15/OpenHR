import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { loadActor } from '../common/access';
import { CurrentUser, parse, SessionUser, zDate } from '../common/http';
import { Db } from '../db/db.service';
import { FactorialMigrationService } from './factorial-migration.service';

@Controller('migration')
export class MigrationController {
  constructor(
    private readonly db: Db,
    private readonly factorial: FactorialMigrationService,
  ) {}

  /** Lanza una migración desde Factorial. La clave de API solo se usa en memoria. */
  @Post('factorial')
  async start(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const input = parse(
      z.object({
        apiKey: z.string().trim().min(10).max(500),
        environment: z.enum(['production', 'demo']).default('production'),
        dryRun: z.boolean().default(true),
        shiftsFrom: zDate.optional(),
        includeLeaves: z.boolean().default(true),
        includeSalaries: z.boolean().default(false),
      }),
      body,
    );
    const actor = await this.db.tx(u.tenantId, u.userId, (tx) => loadActor(tx));
    const { apiKey, ...opts } = input;
    return this.factorial.start(actor, u.tenantId, apiKey, opts);
  }

  @Get('jobs')
  jobs(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.factorial.listJobs(tx, await loadActor(tx)));
  }

  @Get('jobs/:id')
  job(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.factorial.getJob(tx, await loadActor(tx), id));
  }
}
