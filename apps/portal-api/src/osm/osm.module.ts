// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { EngineModule } from '../engine/engine.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OverpassClient } from './overpass-client.js';
import { OsmService } from './osm.service.js';
import { OsmScrubService } from './osm-scrub.service.js';

/**
 * Wires the OSM overlay adapter (#OSM).  Exports OsmService so the
 * recipe runner can resolve `osm-query` SourceRefs into transient
 * observation-log scopes that the spatial-filter SQL emitter
 * consumes like any other source.
 *
 * OsmScrubService (#100) is registered as a provider so the @Cron
 * decorator binds at module init. LeaderElectionService is global
 * (see leader-election.module.ts), so we don't need to import its
 * module here -- only the cron-leader replica runs the scrub.
 */
@Module({
  imports: [PrismaModule, EngineModule],
  providers: [OverpassClient, OsmService, OsmScrubService],
  exports: [OsmService],
})
export class OsmModule {}
