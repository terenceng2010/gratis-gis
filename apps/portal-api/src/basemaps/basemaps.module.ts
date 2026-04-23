import { Module } from '@nestjs/common';

import { BasemapsController } from './basemaps.controller.js';
import { BasemapsService } from './basemaps.service.js';

@Module({
  controllers: [BasemapsController],
  providers: [BasemapsService],
  exports: [BasemapsService],
})
export class BasemapsModule {}
