// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import type { GeoJsonGeometry } from '@gratis-gis/engine';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { DerivedLayerCacheRefreshService } from '../derived-layers/cache-refresh.service.js';
import {
  DataLayerEngine,
  type CreateFeatureArgs,
} from '../engine/data-layer.js';

/**
 * Per-layer feature CRUD for v3 data_layer items.
 *
 * Post-Phase-2.2 this is a thin wrapper over `DataLayerEngine`. The
 * controller-facing surface (DTOs, response shapes, own-rows-only
 * guard, cache-refresh notifications, error semantics) is preserved
 * byte-for-byte; the SQL that used to hit per-layer `fs_*` tables
 * now flows through the observation log via the engine adapter.
 *
 * Per-layer tables still get provisioned upstream by `ItemsService`
 * but they are no longer written to or read from. They become
 * orphans until sub-phase 2.5/2.6 stops creating them and drops the
 * existing ones.
 *
 * Behaviour deltas to know about:
 *
 * - The `SELECT...FOR UPDATE + UPDATE valid_to + INSERT new`
 *   transaction in updateFeature collapses into a single observation
 *   write. The append-only log is naturally last-writer-wins; no
 *   row-level lock is necessary.
 * - The typed-column projection on per-layer tables is gone.
 *   Features land as JSONB `attrs` only. Attribute lookups go
 *   through `attrs->>'field'` (with type casts when needed) instead
 *   of dedicated typed columns.
 * - The `isTable` flag still skips spatial filters in the read path,
 *   matching the v3 wire contract; geometry is just `null` for
 *   table-shaped sublayers.
 * - `gid` (the per-layer integer auto-increment id) is no longer
 *   returned. Callers that need a stable per-row identifier use
 *   `id` (the entity UUID) which has been the public identifier
 *   anyway.
 */

export interface V3FeatureInsert {
  globalId?: string;
  geometry?: unknown;
  properties?: Record<string, unknown> | undefined;
}

export interface V3FeatureOut {
  type: 'Feature';
  id: string;
  geometry: unknown;
  properties: Record<string, unknown>;
}

@Injectable()
export class V3FeaturesService {
  private readonly log = new Logger(V3FeaturesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheRefresh: DerivedLayerCacheRefreshService,
    private readonly dataLayer: DataLayerEngine,
  ) {}

  /** Current-state feature collection for a layer. Supports bbox
   *  filter + point-in-time (`at`), per-share `geoLimit`, layer
   *  `boundaryClip`, `ownRowsOnly`, and `parentFkFilter`. The
   *  semantics are unchanged from the per-layer-table era; the SQL
   *  underneath now hits the observation log. */
  async listFeatures(
    itemId: string,
    layerId: string,
    opts: {
      bbox?: [number, number, number, number];
      at?: string;
      geoLimit?: unknown;
      boundaryClip?: unknown;
      ownRowsOnly?: { userId: string };
      isTable?: boolean;
      parentFkFilter?: { column: string; parentId: string };
    } = {},
  ): Promise<{ type: 'FeatureCollection'; features: V3FeatureOut[] }> {
    const result = await this.dataLayer.listFeatures({
      itemId,
      layerId,
      ...(opts.at !== undefined ? { asOf: new Date(opts.at) } : {}),
      ...(opts.bbox !== undefined ? { bbox: opts.bbox } : {}),
      ...(opts.geoLimit !== undefined
        ? { geoLimit: opts.geoLimit as GeoJsonGeometry }
        : {}),
      ...(opts.boundaryClip !== undefined
        ? { boundaryClip: opts.boundaryClip as GeoJsonGeometry }
        : {}),
      ...(opts.ownRowsOnly !== undefined
        ? { ownRowsOnly: opts.ownRowsOnly }
        : {}),
      ...(opts.parentFkFilter !== undefined
        ? { parentFkFilter: opts.parentFkFilter }
        : {}),
      ...(opts.isTable === true ? { isTable: true } : {}),
    });
    return result;
  }

  /** Bulk-insert features. Optional client-supplied `globalId` is
   *  passed through as the entity id (idempotency for retried POSTs).
   *  Routes the batch through `DataLayerEngine.writeFeaturesCreate`,
   *  which fans out to `EngineService.writeMany` (500-row INSERT
   *  chunks) so 100k+ row imports still land in a single API call.
   *
   *  The `isTable` flag is accepted for signature parity with the
   *  pre-engine v3 service; it is no longer used because the engine
   *  handles non-spatial sublayers naturally (null geom). */
  async insertFeatures(
    itemId: string,
    layerId: string,
    inputs: V3FeatureInsert[],
    user: AuthUser,
    _opts: { isTable?: boolean } = {},
  ): Promise<{ inserted: number }> {
    if (inputs.length === 0) return { inserted: 0 };

    const principal = { sub: user.id, displayName: user.username ?? '' };
    const args: CreateFeatureArgs[] = inputs.map((f) => ({
      itemId,
      layerId,
      principal,
      ...(f.globalId !== undefined ? { globalId: f.globalId } : {}),
      ...(f.properties !== undefined ? { properties: f.properties } : {}),
      ...(f.geometry !== undefined
        ? { geometry: f.geometry as GeoJsonGeometry | null }
        : {}),
    }));

    const written = await this.dataLayer.writeFeaturesCreate(args);
    this.log.log(
      `Inserted ${written.length} features into data_layer:${itemId}:${layerId}`,
    );

    // Lazy-grow buffer-by-field caches on any derived layer that
    // reads from this source. Best-effort: notifySourceWrite swallows
    // its own errors so an insert that goes through here is never
    // rolled back by a downstream cache problem.
    void this.cacheRefresh.notifySourceWrite(
      itemId,
      layerId,
      inputs.map((f) => f.properties),
    );

    return { inserted: written.length };
  }

  /** Update a feature. Reads the current state through the adapter
   *  (which doubles as the existence + ownership check), merges the
   *  patch with the current values, writes a `kind: 'update'`
   *  observation, and reads the result back. The pre-engine
   *  SELECT-FOR-UPDATE transaction is gone; the append-only log is
   *  naturally last-writer-wins. */
  async updateFeature(
    itemId: string,
    layerId: string,
    featureId: string,
    patch: { geometry?: unknown; properties?: Record<string, unknown> },
    user: AuthUser,
    opts: { ownRowsOnly?: boolean; isTable?: boolean } = {},
  ): Promise<V3FeatureOut> {
    const isTable = opts.isTable === true;

    // Look up the current state. The candidate-entities CTE inside
    // listFeatures filters by created_by when ownRowsOnly is set, so
    // a feature that exists but was created by someone else will
    // come back empty here; we surface that as NotFound to match the
    // pre-engine "don't leak existence" pattern.
    const current = await this.dataLayer.listFeatures({
      itemId,
      layerId,
      entity: featureId,
      ...(opts.ownRowsOnly === true
        ? { ownRowsOnly: { userId: user.id } }
        : {}),
      ...(isTable ? { isTable: true } : {}),
    });
    if (current.features.length === 0) {
      throw new NotFoundException('Feature not found');
    }
    const existing = current.features[0]!;

    const stripUnderscoreKeys = (
      props: Record<string, unknown>,
    ): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (!k.startsWith('_')) out[k] = v;
      }
      return out;
    };

    const nextProps =
      patch.properties !== undefined
        ? patch.properties
        : stripUnderscoreKeys(existing.properties);

    const nextGeometry: GeoJsonGeometry | null = isTable
      ? null
      : patch.geometry !== undefined
        ? (patch.geometry as GeoJsonGeometry | null)
        : existing.geometry;

    const principal = { sub: user.id, displayName: user.username ?? '' };
    await this.dataLayer.writeFeatureUpdate({
      itemId,
      layerId,
      globalId: featureId,
      principal,
      properties: nextProps,
      geometry: nextGeometry,
    });

    const refreshed = await this.dataLayer.listFeatures({
      itemId,
      layerId,
      entity: featureId,
      ...(isTable ? { isTable: true } : {}),
    });
    const result = refreshed.features[0];
    if (result === undefined) {
      // Defensive: writeFeatureUpdate succeeded but the read came
      // back empty. Treat as 500-equivalent rather than masquerading
      // as 404; this should not happen.
      throw new Error('Feature update succeeded but read-back returned no rows');
    }

    void this.cacheRefresh.notifySourceWrite(itemId, layerId, [nextProps]);
    return result;
  }

  /** Soft-delete a feature by appending a `kind: 'delete'`
   *  observation. The read path filters tombstones out, so the
   *  entity disappears from feature collections; nothing is
   *  physically removed from the log. */
  async deleteFeature(
    itemId: string,
    layerId: string,
    featureId: string,
    user: AuthUser,
    opts: { ownRowsOnly?: boolean } = {},
  ): Promise<void> {
    const current = await this.dataLayer.listFeatures({
      itemId,
      layerId,
      entity: featureId,
      ...(opts.ownRowsOnly === true
        ? { ownRowsOnly: { userId: user.id } }
        : {}),
    });
    if (current.features.length === 0) {
      throw new NotFoundException('Feature not found');
    }

    const principal = { sub: user.id, displayName: user.username ?? '' };
    await this.dataLayer.writeFeatureDelete({
      itemId,
      layerId,
      globalId: featureId,
      principal,
    });
  }
}
