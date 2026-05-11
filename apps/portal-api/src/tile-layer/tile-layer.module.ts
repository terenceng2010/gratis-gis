// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { ItemsModule } from '../items/items.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { TileLayerController } from './tile-layer.controller.js';
import { TileLayerService } from './tile-layer.service.js';

/**
 * Tile layer wiring (#179). Depends on ItemsModule for the
 * canonical item CRUD + ACL pipeline, and StorageModule for
 * presigned uploads / cleanup deletes against MinIO.
 *
 * Exports the service so ItemsService can wire it into the
 * cross-storage cleanup path that runs on item purge.
 */
@Module({
  imports: [ItemsModule, StorageModule],
  controllers: [TileLayerController],
  providers: [TileLayerService],
  exports: [TileLayerService],
})
export class TileLayerModule {}
