import { BadRequestException, Controller, Get, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { loadActor } from '../common/access';
import { CurrentUser, parse, SessionUser, zDate, zPeriod, zUuid } from '../common/http';
import { Db } from '../db/db.service';
import { sendFile } from '../documents/documents.controller';
import { IMPORT_COLUMNS, ImportsService } from '../imports/imports.service';
import { ExportsService, toCsv } from './exports.service';

@Controller()
export class ExportsController {
  constructor(
    private readonly db: Db,
    private readonly exports: ExportsService,
    private readonly imports: ImportsService,
  ) {}

  @Get('exports/time-register')
  async timeRegister(
    @CurrentUser() u: SessionUser,
    @Query() query: Record<string, string>,
    @Res() res: Response,
  ) {
    const q = parse(
      z
        .object({ companyId: zUuid.optional(), employmentId: zUuid.optional(), from: zDate, to: zDate })
        .refine((v) => v.from <= v.to, 'Rango no válido')
        .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 366, 'Máximo un año por exportación'),
      query,
    );
    const file = await this.db.tx(u.tenantId, u.userId, async (tx) => this.exports.timeRegister(tx, await loadActor(tx), q));
    res.setHeader('X-Content-SHA256', file.sha256);
    sendFile(res, file.data, file.filename, 'text/csv; charset=utf-8');
  }

  @Get('exports/payroll-variables')
  async payrollVariables(@CurrentUser() u: SessionUser, @Query() query: Record<string, string>, @Res() res: Response) {
    const q = parse(z.object({ companyId: zUuid, period: zPeriod }), query);
    const file = await this.db.tx(u.tenantId, u.userId, async (tx) => this.exports.payrollVariables(tx, await loadActor(tx), q));
    res.setHeader('X-Content-SHA256', file.sha256);
    sendFile(res, file.data, file.filename, 'text/csv; charset=utf-8');
  }

  @Get('imports/employees/template')
  template(@Res() res: Response) {
    const example = [
      'Lucía', 'García Pérez', '12345678Z', 'lucia@example.com', '600000000', 'B12345678', 'Sede central',
      'Administración', 'Técnica de RR. HH.', 'indefinido', '01/02/2024', '40', '22', '0001', '',
    ];
    sendFile(res, toCsv([[...IMPORT_COLUMNS], example]), 'plantilla-personas.csv', 'text/csv; charset=utf-8');
  }

  @Post('imports/employees')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  importEmployees(
    @CurrentUser() u: SessionUser,
    @Query('dryRun') dryRun: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Falta el fichero CSV');
    return this.db.tx(u.tenantId, u.userId, async (tx) =>
      this.imports.importEmployees(tx, await loadActor(tx), file.buffer, dryRun !== 'false'),
    );
  }
}
