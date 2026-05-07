// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { ItemsModule } from '../items/items.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { V3FeaturesModule } from '../features-v3/v3-features.module.js';
import { V3TablesModule } from '../features-v3/v3-tables.module.js';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';

@Module({
  imports: [ItemsModule, FeaturesModule, V3FeaturesModule, V3TablesModule],
  providers: [IngestService],
  controllers: [IngestController],
})
export class IngestModule {}
