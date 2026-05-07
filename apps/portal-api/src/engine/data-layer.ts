// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Data-layer adapter for the observation-log engine.
//
// The data_layer item type sits on top of the engine substrate but
// preserves the v3-era output shape: a GeoJSON Feature whose `id` is
// the entity's stable UUID and whose `properties` carry both the
// caller-supplied attributes and a small set of underscore-prefixed
// editor-tracking fields (`_created_by`, `_created_at`, `_edited_by`,
// `_edited_at`, `_global_id`). Maps, popups, attribute tables, and
// derived layers all read this shape today; preserving it lets the
// portal-web side keep working unchanged through Phase 2 cutover.
//
// Phase 2.1 introduces this adapter as additive surface. The legacy
// `V3FeaturesService` is unchanged. Phase 2.2 swaps the v3 service's
// internals to call into this adapter.

import { Injectable } from '@nestjs/common';

import {
  type GeoJsonGeometry,
  type Observation,
  type PrincipalRef,
  type SourceRef,
  uuidv7,
} from '@gratis-gis/engine';

import { EngineService } from './engine.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Argument bag shared by every write helper. */
interface WriteCommon {
  itemId: string;
  layerId: string;
  principal: PrincipalRef;
  /** Optional override for the source bookkeeping. Defaults to a
   *  generic `data_layer:write` tag. */
  source?: SourceRef;
}

export interface CreateFeatureArgs extends WriteCommon {
  /** Caller-supplied attribute payload. Spread into `attrs`. */
  properties?: Record<string, unknown>;
  /** Optional geometry. Cell is computed downstream by `EngineService`. */
  geometry?: GeoJsonGeometry | null;
  /**
   * Optional client-supplied entity id. When present, used as the
   * observation's `entity` instead of generating a fresh UUIDv7.
   * Editors and form runtimes pass this through so a retried POST
   * after a network blip does not produce a duplicate feature; if
   * the same `globalId` lands twice the second write fails the
   * primary-key constraint on `observation.id` and the caller treats
   * it as already-persisted.
   *
   * Must be a valid UUID. Validation happens inside the engine.
   */
  globalId?: string;
}

export interface UpdateFeatureArgs extends WriteCommon {
  /** Existing entity id (the v3-era `global_id`). */
  globalId: string;
  /** Replacement attributes. Engine takes the value as-is; partial
   *  updates are the caller's job (read-merge-write pattern lives
   *  in the v3 wrapper). */
  properties?: Record<string, unknown>;
  /** Replacement geometry, or `null` to drop. */
  geometry?: GeoJsonGeometry | null;
}

export interface DeleteFeatureArgs extends WriteCommon {
  globalId: string;
}

export interface ListFeaturesArgs {
  itemId: string;
  layerId: string;
  /** As-of timestamp for bitemporal reads. Defaults to `now`. */
  asOf?: Date;
  /** Cap on returned features. Engine-default 1000. */
  limit?: number;
}

export interface DataLayerFeature {
  type: 'Feature';
  /** Stable entity id. Identical to v3's `global_id`. */
  id: string;
  geometry: GeoJsonGeometry | null;
  properties: Record<string, unknown> & {
    _global_id: string;
    _created_by: string;
    _created_at: string;
    _edited_by: string;
    _edited_at: string;
  };
}

interface CreationRow {
  entity: string;
  author_sub: string;
  tx_time: Date;
}

const DEFAULT_SOURCE: SourceRef = { kind: 'data_layer:write' };

/**
 * Encode a `(itemId, layerId)` pair as the canonical engine scope
 * for a data_layer sublayer. Every adapter call uses this; no other
 * surface should construct scopes by hand.
 */
export function dataLayerScope(itemId: string, layerId: string): string {
  return `data_layer:${itemId}:${layerId}`;
}

@Injectable()
export class DataLayerEngine {
  constructor(
    private readonly engine: EngineService,
    private readonly prisma: PrismaService,
  ) {}

  scope(itemId: string, layerId: string): string {
    return dataLayerScope(itemId, layerId);
  }

  /**
   * Create a new feature. Generates a fresh entity id (UUIDv7) and
   * writes a single `kind: 'create'` observation. The entity id is
   * surfaced as `globalId` for v3 callers that store it on the
   * client side.
   */
  async writeFeatureCreate(
    args: CreateFeatureArgs,
  ): Promise<{ globalId: string; observationId: string }> {
    const entity = args.globalId ?? uuidv7();
    const obs = await this.engine.write({
      scope: this.scope(args.itemId, args.layerId),
      entity,
      kind: 'create',
      validFrom: new Date(),
      validTo: null,
      attrs: args.properties ?? null,
      geom: args.geometry ?? null,
      author: args.principal,
      source: args.source ?? DEFAULT_SOURCE,
      parents: [],
    });
    return { globalId: entity, observationId: requireId(obs.id) };
  }

  /**
   * Bulk variant of `writeFeatureCreate`. Used by the v3 ingest path
   * and by anything else that produces many features at once. Routes
   * through `EngineService.writeMany`, so all rows land in batched
   * INSERTs (500 per statement) and a 100k-row import stays under
   * the BFF timeout.
   *
   * Each input gets a fresh UUIDv7 entity id. The returned array is
   * order-aligned with the input array.
   */
  async writeFeaturesCreate(
    inputs: CreateFeatureArgs[],
  ): Promise<Array<{ globalId: string; observationId: string }>> {
    if (inputs.length === 0) return [];

    const observations: Observation[] = inputs.map((args) => ({
      scope: this.scope(args.itemId, args.layerId),
      entity: args.globalId ?? uuidv7(),
      kind: 'create',
      validFrom: new Date(),
      validTo: null,
      attrs: args.properties ?? null,
      geom: args.geometry ?? null,
      author: args.principal,
      source: args.source ?? DEFAULT_SOURCE,
      parents: [],
    }));

    const written = await this.engine.writeMany(observations);
    return written.map((obs) => ({
      globalId: obs.entity,
      observationId: requireId(obs.id),
    }));
  }

  /**
   * Append a `kind: 'update'` observation for an existing entity.
   * The latest observation per entity is what the read path returns,
   * so writing a new observation is enough; we never mutate prior
   * rows.
   */
  async writeFeatureUpdate(
    args: UpdateFeatureArgs,
  ): Promise<{ observationId: string }> {
    const obs = await this.engine.write({
      scope: this.scope(args.itemId, args.layerId),
      entity: args.globalId,
      kind: 'update',
      validFrom: new Date(),
      validTo: null,
      attrs: args.properties ?? null,
      geom: args.geometry ?? null,
      author: args.principal,
      source: args.source ?? DEFAULT_SOURCE,
      parents: [],
    });
    return { observationId: requireId(obs.id) };
  }

  /**
   * Tombstone an entity by appending a `kind: 'delete'` observation.
   * The read path filters tombstones out, so the entity disappears
   * from feature collections without anything being physically
   * removed from the log.
   */
  async writeFeatureDelete(
    args: DeleteFeatureArgs,
  ): Promise<{ observationId: string }> {
    const obs = await this.engine.write({
      scope: this.scope(args.itemId, args.layerId),
      entity: args.globalId,
      kind: 'delete',
      validFrom: new Date(),
      validTo: null,
      attrs: null,
      geom: null,
      author: args.principal,
      source: args.source ?? DEFAULT_SOURCE,
      parents: [],
    });
    return { observationId: requireId(obs.id) };
  }

  /**
   * Read the features in a data_layer sublayer at `asOf` (default
   * `now`). The output preserves v3's wire shape so existing
   * controllers, the layer detail page, and the map renderer keep
   * working without changes.
   *
   * Tracking metadata is surfaced as underscore-prefixed properties:
   *
   * - `_global_id` mirrors `Feature.id` so MapLibre's `generateId`
   *   does not clobber the entity link.
   * - `_created_by` / `_created_at` come from the entity's first
   *   `kind: 'create'` observation, fetched in a single batched query.
   * - `_edited_by` / `_edited_at` come from the latest non-delete
   *   observation, which is exactly what `EngineService.read` already
   *   returns.
   */
  async listFeatures(args: ListFeaturesArgs): Promise<DataLayerFeature[]> {
    const scope = this.scope(args.itemId, args.layerId);
    const features = await this.engine.read({
      scope,
      ...(args.asOf !== undefined ? { asOf: args.asOf } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
    if (features.length === 0) return [];

    const entities = features.map((f) => f.id);
    const tracking = await this.fetchCreationMetadata(scope, entities);

    return features.map((f) => {
      const baseProps: Record<string, unknown> = { ...f.properties };
      const meta = f.properties.__engine;
      delete baseProps.__engine;
      const created = tracking.get(f.id);
      return {
        type: 'Feature',
        id: f.id,
        geometry: f.geometry,
        properties: {
          ...baseProps,
          _global_id: f.id,
          _created_by: created?.authorSub ?? meta.authorSub,
          _created_at: created?.txTime.toISOString() ?? meta.txTime,
          _edited_by: meta.authorSub,
          _edited_at: meta.txTime,
        },
      };
    });
  }

  /**
   * Look up creation metadata (`author_sub` and `tx_time` of each
   * entity's first `kind: 'create'` observation) for a batch of
   * entity ids. Returns a Map for O(1) lookup during feature
   * assembly.
   *
   * Implemented as a single `DISTINCT ON (entity)` query so reading
   * N features costs two round-trips total, not N+1.
   */
  private async fetchCreationMetadata(
    scope: string,
    entities: string[],
  ): Promise<Map<string, { authorSub: string; txTime: Date }>> {
    if (entities.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<CreationRow[]>`
      SELECT DISTINCT ON (entity) entity, author_sub, tx_time
      FROM observation
      WHERE scope = ${scope}
        AND entity = ANY(${entities}::uuid[])
        AND kind = 'create'
      ORDER BY entity, valid_from ASC, tx_time ASC
    `;
    const out = new Map<string, { authorSub: string; txTime: Date }>();
    for (const row of rows) {
      out.set(row.entity, { authorSub: row.author_sub, txTime: row.tx_time });
    }
    return out;
  }
}

function requireId(id: string | undefined): string {
  if (id === undefined) {
    throw new Error('engine returned observation without id');
  }
  return id;
}
