// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { ItemsModule } from '../items/items.module.js';
import { IngestModule } from '../ingest/ingest.module.js';
import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { DataLayerTablesModule } from '../data-layer/tables.module.js';

import { ImportJobsService } from './import-jobs.service.js';
import { ImportJobsController } from './import-jobs.controller.js';
import { ImportJobsWorker } from './import-jobs.worker.js';

/**
 * Async import jobs (#115). Brings together:
 *
 *   - the persistence + lifecycle service (ImportJobsService)
 *   - the HTTP surface (ImportJobsController)
 *   - the in-process worker that drains queued jobs
 *     (ImportJobsWorker)
 *
 * Imports IngestModule (for the GDAL streaming reader and the
 * staging service) and the data-layer modules (for the truncate +
 * feature insert + bbox aggregation paths). The worker reuses
 * the existing services rather than duplicating their logic.
 */
@Module({
  imports: [
    PrismaModule,
    ItemsModule,
    IngestModule,
    DataLayerFeaturesModule,
    DataLayerTablesModule,
  ],
  providers: [ImportJobsService, ImportJobsWorker],
  controllers: [ImportJobsController],
  exports: [ImportJobsService],
})
export class ImportJobsModule {}
