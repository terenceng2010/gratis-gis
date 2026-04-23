import { Module } from '@nestjs/common';

import { ItemsModule } from '../items/items.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';

@Module({
  imports: [ItemsModule, FeaturesModule],
  providers: [IngestService],
  controllers: [IngestController],
})
export class IngestModule {}
