// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from '@gratis-gis/engine';

import { EngineService } from '../engine/engine.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OverpassClient } from './overpass-client.js';
import { buildOverpassQl } from './overpass-ql.js';
import {
  osmToGeoJson,
  type OsmGeoJsonFeature,
  type OsmGeoJsonGeometry,
} from './osm-to-geojson.js';
import { getOsmPresets } from './preset-catalog.js';

/**
 * Resolved input shape for one OSM source resolution.  Mirrors the
 * `osm-query` SourceRef variant in shared-types post-substitution,
 * plus the AOI-derived bbox the recipe runner computes.
 */
export interface OsmSourceResolveInput {
  presetIds: string[];
  tagFilters?: Array<{ key: string; value: string; op?: 'equals' | 'contains' | 'regex' }>;
  bbox: [number, number, number, number];
  /** Override endpoint; falls back to the environment default. */
  endpoint?: string;
  /** Override TTL (ms); falls back to 1h. */
  ttlMs?: number;
  /** Override max features; falls back to 50000. */
  maxFeatures?: number;
}

export interface OsmResolveResult {
  /** observation-log scope key downstream SQL can read from. */
  scope: string;
  /** Number of features the resolver wrote (or matched in cache). */
  featureCount: number;
  /** True when a cache hit served the request; false on a fresh
   *  Overpass call.  Useful for telemetry. */
  cacheHit: boolean;
  /** The features in GeoJSON form, for callers that want them
   *  directly (e.g. the osm-features-overlay output sink that
   *  surfaces them on the host map without going through the SQL
   *  layer). */
  features: OsmGeoJsonFeature[];
  /** Attribution string suitable for surfacing in the UI.
   *  Required by ODbL whenever OSM-derived features are shown. */
  attribution: string;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const ATTRIBUTION = '© OpenStreetMap contributors';

@Injectable()
export class OsmService {
  private readonly logger = new Logger(OsmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: EngineService,
    private readonly client: OverpassClient,
  ) {}

  /**
   * Resolve an `osm-query` SourceRef into a populated observation
   * scope.  Returns either the cached scope (when fresh) or a
   * newly-materialised one (when the cache is cold or expired).
   *
   * The bbox is rounded to ~10m precision before hashing so a
   * recipe rerun with a fractionally-different AOI still hits the
   * same cache row.  Tag filters are normalised (sorted by key,
   * lowercased ops) so call-site key ordering doesn't fragment the
   * cache.
   */
  async resolve(input: OsmSourceResolveInput): Promise<OsmResolveResult> {
    if (!input.presetIds || input.presetIds.length === 0) {
      throw new Error('OsmService.resolve: presetIds must not be empty');
    }
    const endpoint = input.endpoint ?? process.env.GRATIS_GIS_OSM_OVERPASS_ENDPOINT ?? DEFAULT_ENDPOINT;
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
    const maxFeatures = input.maxFeatures ?? 50000;

    const hash = hashQuery(input, endpoint);

    // Cache lookup.
    const cached = await this.prisma.osmQueryCache.findUnique({
      where: { hash },
    });
    if (cached && cached.expiresAt.getTime() > Date.now()) {
      // Fresh.  Skip Overpass; pull features out of the
      // observation log via the engine read path.
      const features = await this.readFeaturesFromScope(cached.scope);
      return {
        scope: cached.scope,
        featureCount: cached.featureCount,
        cacheHit: true,
        features,
        attribution: ATTRIBUTION,
      };
    }

    // Cache miss: hit Overpass.
    const presets = await getOsmPresets(input.presetIds);
    const ql = buildOverpassQl({
      presets,
      ...(input.tagFilters ? { tagFilters: input.tagFilters } : {}),
      bbox: input.bbox,
      maxFeatures,
    });
    this.logger.log(
      `OSM resolve (cache miss): presets=${input.presetIds.join(',')} bbox=${input.bbox.join(',')} -> Overpass`,
    );
    const response = await this.client.run({ endpoint, ql });
    const collection = osmToGeoJson(response);
    const features = collection.features.slice(0, maxFeatures);

    const scope = `osm:${hash}`;
    await this.writeFeaturesToScope(scope, features);

    // Persist (or refresh) the cache row.
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.prisma.osmQueryCache.upsert({
      where: { hash },
      create: {
        hash,
        scope,
        presetIds: input.presetIds,
        ...(input.tagFilters && input.tagFilters.length > 0
          ? { tagFilters: input.tagFilters as unknown as object }
          : {}),
        bbox: input.bbox as unknown as object,
        featureCount: features.length,
        endpoint,
        fetchedAt: new Date(),
        expiresAt,
      },
      update: {
        scope,
        presetIds: input.presetIds,
        ...(input.tagFilters && input.tagFilters.length > 0
          ? { tagFilters: input.tagFilters as unknown as object }
          : { tagFilters: undefined as unknown as object }),
        bbox: input.bbox as unknown as object,
        featureCount: features.length,
        endpoint,
        fetchedAt: new Date(),
        expiresAt,
      },
    });

    return {
      scope,
      featureCount: features.length,
      cacheHit: false,
      features,
      attribution: ATTRIBUTION,
    };
  }

  /**
   * Write a GeoJSON FeatureCollection into the observation log
   * under the given scope.  Each Feature becomes a single
   * `create` observation; the scope is a transient namespace
   * that the cache scrub job tears down when the cache row
   * expires.
   *
   * We delete any prior observations under this scope before the
   * write so a re-resolution under the same hash (which can only
   * happen if the cache expired but the same query is being
   * re-run) doesn't leave stale features behind.
   */
  private async writeFeaturesToScope(
    scope: string,
    features: OsmGeoJsonFeature[],
  ): Promise<void> {
    // Defensive clean-up: drop any prior observations.
    await this.prisma.$executeRaw`DELETE FROM observation WHERE scope = ${scope}`;
    if (features.length === 0) return;

    // The osm-bot principal carries every OSM-derived observation.
    // Real users never write to OSM scopes; the engine's writeable
    // surfaces are scoped by data_layer item id and never touch
    // `osm:*`.
    const author = { sub: 'osm-bot', displayName: 'OpenStreetMap import' };
    const now = new Date();

    for (const feat of features) {
      const entity = uuidv7();
      await this.engine.write({
        scope,
        entity,
        kind: 'create',
        validFrom: now,
        validTo: null,
        geom: (feat.geometry as unknown) ?? null,
        attrs: (feat.properties as Record<string, unknown> | null) ?? null,
        author,
        source: { kind: 'osm-overpass', queryScope: scope },
        parents: [],
      } as unknown as Parameters<EngineService['write']>[0]);
    }
  }

  /**
   * Pull the materialised features back out of the observation log
   * scope as GeoJSON Features.  Used on cache hits when the
   * recipe-runner caller wants the features inline (the
   * osm-features-overlay output sink does).
   */
  private async readFeaturesFromScope(scope: string): Promise<OsmGeoJsonFeature[]> {
    type Row = {
      entity: string;
      geom: string | null;
      attrs: Record<string, unknown> | null;
    };
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT entity, ST_AsGeoJSON(geom) AS geom, attrs
      FROM (
        SELECT DISTINCT ON (entity)
          entity, geom, attrs, kind, valid_from, tx_time
        FROM observation
        WHERE scope = ${scope}
        ORDER BY entity, valid_from DESC, tx_time DESC
      ) latest
      WHERE kind <> 'delete'
    `;
    return rows.map((r) => ({
      type: 'Feature' as const,
      id: r.entity,
      geometry: r.geom ? (JSON.parse(r.geom) as OsmGeoJsonGeometry) : (null as unknown as OsmGeoJsonGeometry),
      properties: r.attrs ?? {},
    }));
  }
}

/**
 * Deterministic content hash for the cache key.  Rounds bbox to
 * ~5 decimal places (about 1m at the equator) so a fractionally-
 * different AOI redraw still hits the same cache row.  Sorts tag
 * filters so the call-site iteration order doesn't fragment the
 * cache key.
 */
function hashQuery(input: OsmSourceResolveInput, endpoint: string): string {
  const rounded = input.bbox.map((x) => Math.round(x * 1e5) / 1e5);
  const sortedFilters = (input.tagFilters ?? [])
    .slice()
    .sort((a, b) =>
      a.key === b.key
        ? a.value.localeCompare(b.value)
        : a.key.localeCompare(b.key),
    );
  const tuple = JSON.stringify({
    p: input.presetIds.slice().sort(),
    t: sortedFilters,
    b: rounded,
    e: endpoint,
  });
  return createHash('sha256').update(tuple).digest('hex').slice(0, 32);
}
