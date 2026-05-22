// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module.js';
import { ItemsModule } from '../items/items.module.js';

import { AgoDryRunService } from './dry-run.js';
import { AgoImportService } from './import.js';
import { ImportAgoController } from './import-ago.controller.js';

/**
 * Wires the AGO migration importer. Depends on:
 *
 *   - ``ItemsModule`` for ``ItemsService`` (per-type item
 *     creation) and ``WebMapJsonImportService`` (Web Map
 *     conversion).
 *   - ``AdminModule`` for the ``AdminGuard`` the controller
 *     enforces.
 */
@Module({
  imports: [ItemsModule, AdminModule],
  controllers: [ImportAgoController],
  providers: [AgoDryRunService, AgoImportService],
  exports: [AgoDryRunService, AgoImportService],
})
export class ImportAgoModule {}
