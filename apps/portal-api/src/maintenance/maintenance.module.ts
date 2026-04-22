import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { TrashPurgeService } from './trash-purge.service.js';

/**
 * Home for scheduled maintenance work (trash purge today; more later,
 * e.g. thumbnail garbage collection, storage reconciliation).
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [TrashPurgeService],
})
export class MaintenanceModule {}
