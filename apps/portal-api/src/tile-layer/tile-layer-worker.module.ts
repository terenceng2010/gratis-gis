// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { TileLayerPyramidWorker } from './pyramid.worker.js';

/**
 * Worker-only side of tile_layer post-processing.
 *
 * The pyramid worker polls Item rows of type='tile_layer' that
 * landed via the raw-raster upload path (data.processingState =
 * 'cog-ready') and builds a PMTiles raster pyramid from the COG.
 * On success the item flips to format='pmtiles' and serves from
 * the new file; on failure it stays serving from the COG.
 *
 * Lives in its own module (separate from TileLayerModule) so the
 * worker container can load it without dragging in the HTTP /
 * auth surface.  The api container does NOT load this module;
 * that keeps the worker's polling loop from running in N
 * processes when api scales out.
 */
@Module({
  imports: [PrismaModule, StorageModule],
  providers: [TileLayerPyramidWorker],
})
export class TileLayerWorkerModule {}
