import { Module } from '@nestjs/common';

import { ItemsModule } from '../items/items.module.js';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';

@Module({
  imports: [ItemsModule],
  providers: [IngestService],
  controllers: [IngestController],
})
export class IngestModule {}
