import { Module } from '@nestjs/common';

import { StorageController } from './storage.controller.js';
import { StorageService } from './storage.service.js';

@Module({
  providers: [StorageService],
  controllers: [StorageController],
  exports: [StorageService],
})
export class StorageModule {}
