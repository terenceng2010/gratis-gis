import { Module } from '@nestjs/common';
import { ItemsController } from './items.controller.js';
import { ItemsService } from './items.service.js';
import { SharingService } from './sharing.service.js';
import { DataSnapshotService } from './data-snapshot.service.js';
import { V3TablesModule } from '../features-v3/v3-tables.module.js';

@Module({
  imports: [V3TablesModule],
  controllers: [ItemsController],
  providers: [ItemsService, SharingService, DataSnapshotService],
  exports: [ItemsService, SharingService, DataSnapshotService],
})
export class ItemsModule {}
