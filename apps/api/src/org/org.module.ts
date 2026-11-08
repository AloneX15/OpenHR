import { Module } from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { OrgController } from './org.controller';

@Module({ controllers: [OrgController], providers: [EmployeesService], exports: [EmployeesService] })
export class OrgModule {}
