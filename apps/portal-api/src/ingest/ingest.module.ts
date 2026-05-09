// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { ItemsModule } from '../items/items.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { DataLayerTablesModule } from '../data-layer/tables.module.js';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';
import { IngestStagingService } from './ingest-staging.service.js';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ItemsModule,
    FeaturesModule,
    DataLayerFeaturesModule,
    DataLayerTablesModule,
  ],
  providers: [IngestService, IngestStagingService],
  controllers: [IngestController],
})
export class IngestModule {}
