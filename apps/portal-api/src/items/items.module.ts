import { Module } from '@nestjs/common';
import { ItemsController } from './items.controller.js';
import { ItemsService } from './items.service.js';
import { SharingService } from './sharing.service.js';

@Module({
  controllers: [ItemsController],
  providers: [ItemsService, SharingService],
  exports: [ItemsService, SharingService],
})
export class ItemsModule {}
