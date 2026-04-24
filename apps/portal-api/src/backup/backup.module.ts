import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { AdminGuard } from '../admin/admin.guard.js';
import { BackupController } from './backup.controller.js';
import { BackupCronService } from './backup-cron.service.js';
import { BackupService } from './backup.service.js';

/**
 * Bundles the backup controller, the core BackupService, and the
 * cron registrar. ScheduleModule is forRoot'd once elsewhere
 * (MaintenanceModule) but NestJS tolerates re-forRoot in another
 * module tree — the underlying scheduler is a singleton — so we do
 * it here too to keep BackupModule self-contained and independently
 * movable.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [BackupController],
  providers: [BackupService, BackupCronService, AdminGuard],
  exports: [BackupService],
})
export class BackupModule {}
