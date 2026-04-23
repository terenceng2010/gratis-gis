import { Module } from '@nestjs/common';

import { ItemsModule } from '../items/items.module.js';
import { FeaturesController } from './features.controller.js';
import { FeaturesService } from './features.service.js';

@Module({
  imports: [ItemsModule],
  providers: [FeaturesService],
  controllers: [FeaturesController],
  exports: [FeaturesService],
})
export class FeaturesModule {}
