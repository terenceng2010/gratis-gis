// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { EngineModule } from '../engine/engine.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OverpassClient } from './overpass-client.js';
import { OsmService } from './osm.service.js';

/**
 * Wires the OSM overlay adapter (#OSM).  Exports OsmService so the
 * recipe runner can resolve `osm-query` SourceRefs into transient
 * observation-log scopes that the spatial-filter SQL emitter
 * consumes like any other source.
 */
@Module({
  imports: [PrismaModule, EngineModule],
  providers: [OverpassClient, OsmService],
  exports: [OsmService],
})
export class OsmModule {}
