import { Module } from '@nestjs/common';
import { ChecklistsService } from './checklists.service';
import { CustomFieldsService } from './custom-fields.service';
import { EmployeesService } from './employees.service';
import { LifecycleController } from './lifecycle.controller';
import { OrgController } from './org.controller';

@Module({
  controllers: [OrgController, LifecycleController],
  providers: [EmployeesService, ChecklistsService, CustomFieldsService],
  exports: [EmployeesService, ChecklistsService, CustomFieldsService],
})
export class OrgModule {}
