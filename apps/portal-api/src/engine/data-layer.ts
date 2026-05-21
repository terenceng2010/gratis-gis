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
// `DataLayerFeaturesService` is unchanged. Phase 2.2 swaps the v3 service's
// internals to call into this adapter.

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  type GeoJsonGeometry,
  type Observation,
  type PrincipalRef,
  type SourceRef,
  uuidv7,
} from '@gratis-gis/engine';

import { EngineService } from './engine.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LensPolicyService } from '../policy/lens-policy.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { validateGeoJson } from '../common/geometry-validation.js';

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
  /** Hard cap on the result set. Defaults to 100,000 to keep
   *  Prisma's napi bridge happy on large layers (matches the v3
   *  service's HARD_CAP). */
  limit?: number;
  /** Single-entity lookup. When set, only the named entity is
   *  returned. Used by callers that want one feature back rather
   *  than the whole collection (e.g. update path read-back). */
  entity?: string;
  /** Viewport filter as `[minLng, minLat, maxLng, maxLat]` in EPSG:4326. */
  bbox?: [number, number, number, number];
  /**
   * Per-share access scope: rows must intersect this polygon (or
   * have null geometry). GeoJSON Polygon, MultiPolygon, or
   * GeometryCollection. Used to enforce share-level geographic
   * restrictions.
   */
  geoLimit?: GeoJsonGeometry;
  /**
   * Layer-level boundary clip: rows must intersect this polygon AND
   * have non-null geometry. Distinct from `geoLimit`; this is the
   * map author's content scope, not a security filter.
   */
  boundaryClip?: GeoJsonGeometry;
  /**
   * When set, restricts the result to features the named user
   * created. Pairs with the share-level rowScope='own' and the
   * layer-level editingPolicy 'own-rows-only'.
   */
  ownRowsOnly?: { userId: string };
  /**
   * Parent-FK filter: narrows to rows whose `attrs->>{column}`
   * equals `parentId`. Used by the field runtime to list children
   * of a given parent feature.
   *
   * The column name is interpolated into the SQL but the caller is
   * responsible for validating it against the layer schema first
   * (the v3 controller does this today).
   */
  parentFkFilter?: { column: string; parentId: string };
  /**
   * Set when the layer was provisioned without a geometry column
   * (the related-records pattern). Skips every spatial filter so
   * non-spatial layers pass through cleanly.
   */
  isTable?: boolean;
  /**
   * Optional row-level policy filter (Cedar Phase D). When set,
   * every feature returned by the SQL query is evaluated against
   * `lensPolicy.policy` via LensPolicyService.checkFeature; rows
   * that fail are dropped from the FeatureCollection.
   *
   * Pass `lens` with both an `id` and a `policy` text. Empty /
   * absent policy text short-circuits to passthrough; same for
   * an absent `lensPolicy` argument entirely (Phase B behaviour).
   *
   * `user` is the principal the policy evaluates against. Required
   * when `lens.policy` is set; ignored otherwise.
   *
   * `spatialKeysFor` pre-resolves spatial predicates per feature.
   * Cedar's WASM has no geometry extension, so callers that want
   * spatial rules ("inside assigned polygon") compute the
   * containment in PostGIS upstream and hand the engine the
   * resulting `Set<string>` of qualifying keys per feature. Lens
   * policies reference the same keys via
   * `resource.spatial.contains("assigned_area")`. When omitted,
   * every feature passes an empty spatial set; non-spatial
   * policies (attribute predicates, role checks) work unchanged.
   */
  lensPolicy?: {
    lens: { id: string; policy?: string };
    user: AuthUser;
    spatialKeysFor?: (feature: DataLayerFeature) => string[];
  };
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

const DEFAULT_SOURCE: SourceRef = { kind: 'data_layer:write' };

/**
 * Encode a `(itemId, layerId)` pair as the canonical engine scope
 * for a data_layer sublayer. Every adapter call uses this; no other
 * surface should construct scopes by hand.
 */
export function dataLayerScope(itemId: string, layerId: string): string {
  return `data_layer:${itemId}:${layerId}`;
}

/**
 * Build a SQL `SELECT` that materialises the data_layer's current
 * truth from the observation log, exposing the same column shape
 * that the legacy v3 per-layer table did: `global_id`, `geom`,
 * `properties`. Used by callers that compose raw SQL pipelines
 * around a data_layer source (DerivedLayersService is the main
 * one).
 *
 * The scope is embedded as a single-quoted literal because it's
 * built from internal item/layer ids (UUID + identifier shape, no
 * user-supplied content) and the consumers use positional params
 * for their own filters; embedding keeps the param numbering clean
 * for them. We still escape any single quotes defensively.
 *
 * Optional `extraConditions` are AND-joined after the scope filter
 * so each entry must already be a complete `column op value`
 * clause (e.g. `valid_from <= $1`, `geom && ST_MakeEnvelope(...)`).
 *
 * Returns the SELECT body without surrounding parens or alias.
 * Callers wrap as appropriate:
 *   - As a CTE:           `source AS (${fragment})`
 *   - As a FROM source:   `FROM (${fragment}) AS s`
 */
export function dataLayerSourceSqlFragment(
  scope: string,
  opts: {
    extraConditions?: string[];
  } = {},
): string {
  const escapedScope = scope.replace(/'/g, "''");
  const extras =
    opts.extraConditions && opts.extraConditions.length > 0
      ? ` AND ${opts.extraConditions.join(' AND ')}`
      : '';
  // DISTINCT ON entity + ORDER BY valid_from DESC, tx_time DESC
  // gives us the most recent observation per entity within the
  // filter window. Outer WHERE drops entities whose latest is a
  // tombstone (kind = 'delete'), so deleted features fall out.
  return `
    SELECT
      entity AS global_id,
      geom,
      attrs AS properties
    FROM (
      SELECT DISTINCT ON (entity)
        entity, geom, attrs, kind, valid_from, valid_to
      FROM observation
      WHERE scope = '${escapedScope}'${extras}
      ORDER BY entity, valid_from DESC, tx_time DESC
    ) latest
    WHERE kind <> 'delete'
  `;
}

@Injectable()
export class DataLayerEngine {
  constructor(
    private readonly engine: EngineService,
    private readonly prisma: PrismaService,
    private readonly lensPolicy: LensPolicyService,
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
   * COPY-based bulk variant of writeFeaturesCreate. Same input
   * shape, same output shape; the difference is the path the
   * observations take to the database.
   *
   * The caller hands in a started CopyWriter so one transaction
   * can span many batches (cheaper than one transaction per
   * batch). Use only for the async-import-job worker -- online
   * single-row writes still go through writeFeaturesCreate so
   * they pick up validation, derived-layer cache invalidation,
   * and the regular insert path.
   */
  async copyFeaturesCreate(
    inputs: CreateFeatureArgs[],
    writer: import('./copy-writer.js').CopyWriter,
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

    const written = await this.engine.copyMany(observations, writer);
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
   * Bulk variant of `writeFeatureUpdate` (#83 attribute-table Calculate
   * Field).  Same input shape per row, batched through
   * `EngineService.writeMany` so a single calculate-field-on-N-rows
   * call lands in batched INSERTs rather than N round-trips.
   */
  async writeFeaturesUpdate(
    inputs: UpdateFeatureArgs[],
  ): Promise<Array<{ observationId: string }>> {
    if (inputs.length === 0) return [];
    const observations: Observation[] = inputs.map((args) => ({
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
    }));
    const written = await this.engine.writeMany(observations);
    return written.map((obs) => ({ observationId: requireId(obs.id) }));
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
   * Single SQL query that joins the latest-observation-per-entity
   * (DISTINCT ON) against the creation row for the same entity, so
   * the editor-tracking metadata lands without a second round-trip.
   * All v3-era filters (bbox, geoLimit, boundaryClip, ownRowsOnly,
   * parentFkFilter, isTable) are pushed into the WHERE clause.
   *
   * Tombstones (`kind = 'delete'`) are filtered out: deleted
   * entities never appear in the result.
   *
   * Underscore-prefixed properties match the v3 wire shape:
   * `_global_id`, `_created_by`, `_created_at`, `_edited_by`,
   * `_edited_at`.
   */
  async listFeatures(
    args: ListFeaturesArgs,
  ): Promise<{ type: 'FeatureCollection'; features: DataLayerFeature[] }> {
    // Bound user-supplied geometry size before it reaches PostGIS;
    // throws GeometryTooLargeError (BadRequest at the controller).
    validateGeoJson(args.geoLimit);
    validateGeoJson(args.boundaryClip);
    const scope = this.scope(args.itemId, args.layerId);
    const asOf = args.asOf ?? new Date();
    const limit = args.limit ?? 100000;

    const candidateFilters: Prisma.Sql[] = [];
    const currentFilters: Prisma.Sql[] = [];

    if (args.ownRowsOnly !== undefined) {
      candidateFilters.push(
        Prisma.sql`AND author_sub = ${args.ownRowsOnly.userId}`,
      );
    }

    if (args.entity !== undefined) {
      candidateFilters.push(
        Prisma.sql`AND entity = ${args.entity}::uuid`,
      );
    }

    if (!args.isTable) {
      if (args.bbox !== undefined) {
        const [w, s, e, n] = args.bbox;
        currentFilters.push(
          Prisma.sql`AND geom && ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`,
        );
      }
      if (args.geoLimit !== undefined) {
        const json = JSON.stringify(args.geoLimit);
        currentFilters.push(
          Prisma.sql`AND (geom IS NULL OR ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326)))`,
        );
      }
      if (args.boundaryClip !== undefined) {
        const json = JSON.stringify(args.boundaryClip);
        currentFilters.push(
          Prisma.sql`AND geom IS NOT NULL AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326))`,
        );
      }
    }

    if (args.parentFkFilter !== undefined) {
      // Column name is caller-validated against the layer schema in
      // the v3 controller. Quote-safe by virtue of the schema regex
      // matching only [a-z0-9_]+; we still wrap in a JSONB key
      // expression that uses single quotes so the column name lives
      // inside the SQL string, not as a bound parameter (JSONB key
      // operators do not bind via $params).
      const col = sanitizeJsonbKey(args.parentFkFilter.column);
      currentFilters.push(
        Prisma.sql`AND attrs->>${col} = ${args.parentFkFilter.parentId}`,
      );
    }

    interface FeatureRow {
      entity: string;
      observation_id: string;
      attrs: Record<string, unknown> | null;
      geom_geojson: GeoJsonGeometry | null;
      edited_by: string;
      edited_at: Date;
      created_by: string;
      created_at: Date;
    }

    // Prisma.join() rejects an empty array, so collapse to Prisma.empty
    // when no extra filter fragments were collected. Each fragment
    // already begins with `AND` so concatenation is just space-joining.
    const candidateExtras =
      candidateFilters.length > 0
        ? Prisma.join(candidateFilters, ' ')
        : Prisma.empty;
    const currentExtras =
      currentFilters.length > 0
        ? Prisma.join(currentFilters, ' ')
        : Prisma.empty;

    // Per EXPLAIN ANALYZE on a 1.4M-row scope (2026-05-21): the
    // outer LIMIT alone wasn't enough -- Postgres materializes the
    // `currents` CTE (referenced twice: by creates + the outer
    // SELECT) so it computed DISTINCT ON over every entity in the
    // scope before any LIMIT applied, blowing past the 30s
    // statement_timeout for a /items?limit=1 request.
    //
    // ALWAYS limit the `currents` CTE -- it's referenced twice
    // (by creates + the outer SELECT) so Postgres materializes
    // the full DISTINCT ON otherwise, which scans every entity
    // in the scope before the outer LIMIT takes effect. LIMITing
    // here means we get the first N entities by entity-UUID
    // order matching the filters; with bbox present that's a
    // sample of bbox-matching entities (the OAPIF `next` link
    // paginates from there).
    //
    // ONLY push limit into `candidate_entities` when there are no
    // narrowing filters in `currents` (bbox, geoLimit,
    // boundaryClip, parentFkFilter). With those filters present,
    // candidates must be inspected post-filter, so truncating
    // upstream would silently drop matching features.
    const canPushCandidateLimit = currentFilters.length === 0;
    const innerLimit = Math.max(limit * 2, 100);
    const candidateLimit = canPushCandidateLimit
      ? Prisma.sql`ORDER BY entity LIMIT ${innerLimit}`
      : Prisma.empty;
    const currentsLimit = Prisma.sql`LIMIT ${innerLimit}`;
    const rows = await this.prisma.$queryRaw<FeatureRow[]>`
      WITH candidate_entities AS (
        SELECT entity
        FROM observation
        WHERE scope = ${scope}
          AND kind = 'create'
          ${candidateExtras}
        ${candidateLimit}
      ),
      currents AS (
        SELECT DISTINCT ON (entity)
          id AS observation_id,
          entity,
          attrs,
          ST_AsGeoJSON(geom)::jsonb AS geom_geojson,
          kind,
          author_sub AS edited_by,
          tx_time AS edited_at
        FROM observation
        WHERE scope = ${scope}
          AND valid_from <= ${asOf}
          AND entity IN (SELECT entity FROM candidate_entities)
          ${currentExtras}
        ORDER BY entity, valid_from DESC, tx_time DESC
        ${currentsLimit}
      ),
      creates AS (
        SELECT entity,
               author_sub AS created_by,
               tx_time    AS created_at
        FROM observation
        WHERE scope = ${scope}
          AND kind = 'create'
          AND entity IN (SELECT entity FROM currents)
      )
      SELECT
        c.entity,
        c.observation_id,
        c.attrs,
        c.geom_geojson,
        c.edited_by,
        c.edited_at,
        cr.created_by,
        cr.created_at
      FROM currents c
      JOIN creates cr ON cr.entity = c.entity
      WHERE c.kind <> 'delete'
      ORDER BY c.entity
      LIMIT ${limit}
    `;

    const features: DataLayerFeature[] = rows.map((row) => ({
      type: 'Feature',
      id: row.entity,
      geometry: row.geom_geojson,
      properties: {
        ...(row.attrs ?? {}),
        _global_id: row.entity,
        _created_by: row.created_by,
        _created_at: row.created_at.toISOString(),
        _edited_by: row.edited_by,
        _edited_at: row.edited_at.toISOString(),
      },
    }));

    // Phase D: row-level filter through LensPolicyService when the
    // caller attached a lens with policy text. The service short-
    // circuits on absent / whitespace policy so the unpolicied
    // path stays at Phase B speed.
    const filtered = this.applyLensPolicy(features, args.lensPolicy);

    return { type: 'FeatureCollection', features: filtered };
  }

  /**
   * Paged attribute-table read: returns current-state features
   * (attrs only, no geometry) for a layer with optional bbox
   * filter, free-text search, sort, and a hard cap with truncation
   * indicator. The attribute-table card on the map page calls this
   * to populate its rows.
   *
   * Why a separate path instead of reusing listFeatures:
   *
   *   The map attribute table never needs geometry (the map
   *   itself already has it via MVT or otherwise). Sending the
   *   geometry over the wire on a 5000-row response inflates the
   *   payload by 10-100x for polygon-heavy layers. We also don't
   *   need the "current state via DISTINCT ON" CTE structure
   *   because the table view is meant to be a quick slice -- a
   *   simple "currents" pass with the same valid_to/kind filters
   *   is enough.
   *
   *   The LIMIT N+1 trick at the end lets us tell the caller
   *   whether the result set was capped without an extra COUNT
   *   query. If `limit + 1` rows came back we know there's more
   *   and trim the response to exactly `limit`. If fewer, we got
   *   everything.
   *
   * Search (`q`): server-side ILIKE across every JSONB attribute
   * value cast to text. Honest about cost: on a fully-unbounded
   * (no bbox) big-layer query this is a seq scan + sort and will
   * be slow. With a bbox filter (the default UX path) the scan is
   * already bounded to the bbox hit-set; the search runs over
   * that smaller set in sub-second.
   *
   * Sort: any attribute name or one of the synthetic columns
   * (_global_id, _created_at, _edited_at). Same honest-about-cost
   * note as search: bbox-bounded sort is fast; unbounded sort by
   * a non-indexed attr on a 1.4M-row layer is not. The UI's
   * default "extent only" toggle keeps users on the fast path.
   */
  async pageFeatures(args: {
    itemId: string;
    layerId: string;
    bbox?: [number, number, number, number];
    q?: string;
    sort?: string;
    dir?: 'asc' | 'desc';
    limit: number;
    entityIds?: string[];
    geoLimit?: GeoJsonGeometry;
    boundaryClip?: GeoJsonGeometry;
    isTable?: boolean;
  }): Promise<{
    features: Array<{ id: string; properties: Record<string, unknown> }>;
    count: number;
    truncated: boolean;
  }> {
    // Bound user-supplied geometry size before it reaches PostGIS.
    validateGeoJson(args.geoLimit);
    validateGeoJson(args.boundaryClip);
    const scope = this.scope(args.itemId, args.layerId);
    const limit = Math.min(Math.max(args.limit | 0, 1), 5000);
    const fetchN = limit + 1;

    const filters: Prisma.Sql[] = [];
    if (!args.isTable) {
      if (args.bbox !== undefined) {
        const [w, s, e, n] = args.bbox;
        filters.push(
          Prisma.sql`AND geom && ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`,
        );
      }
      if (args.geoLimit !== undefined) {
        const json = JSON.stringify(args.geoLimit);
        filters.push(
          Prisma.sql`AND (geom IS NULL OR ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326)))`,
        );
      }
      if (args.boundaryClip !== undefined) {
        const json = JSON.stringify(args.boundaryClip);
        filters.push(
          Prisma.sql`AND geom IS NOT NULL AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326))`,
        );
      }
    }
    if (args.entityIds !== undefined && args.entityIds.length > 0) {
      // The caller validates these are UUIDs upstream; cast each
      // through ::uuid in the IN clause so a non-uuid string can't
      // reach the planner.
      const ids = args.entityIds.slice(0, 1000);
      filters.push(
        Prisma.sql`AND entity = ANY(ARRAY[${Prisma.join(
          ids.map((id) => Prisma.sql`${id}::uuid`),
        )}])`,
      );
    }
    if (args.q !== undefined && args.q.trim().length > 0) {
      // Pattern-escape the user input so SQL meta-characters don't
      // turn into wildcards. ILIKE pattern: %escaped%.
      const escaped = args.q
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
      const pattern = `%${escaped}%`;
      // Cast the entire JSONB to text and ILIKE over it. This
      // searches every attribute value in one comparison. It's a
      // single per-row predicate so the planner doesn't fan out
      // per-column. Returns false negatives on values stored as
      // numbers/booleans (their text repr matches) which is
      // acceptable -- the user is doing a free-text search, they
      // expect "contains" semantics.
      filters.push(Prisma.sql`AND attrs::text ILIKE ${pattern}`);
    }
    const filterExtras =
      filters.length > 0 ? Prisma.join(filters, ' ') : Prisma.empty;

    // Currency read: DISTINCT ON (entity) over current
    // observations. The SQL-level ORDER BY is fixed (entity,
    // valid_from DESC, tx_time DESC) because that's required for
    // DISTINCT ON to pick the latest row per entity. The CALLER's
    // sort is applied as a JS pass over the bounded result; with
    // limit+1 capped at 5001 the JS sort cost is negligible.
    const sortCol = args.sort;
    const sortDirDesc = args.dir === 'desc';

    interface Row {
      entity: string;
      attrs: Record<string, unknown> | null;
      edited_by: string;
      edited_at: Date;
    }
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT DISTINCT ON (entity)
        entity,
        attrs,
        author_sub AS edited_by,
        tx_time AS edited_at
      FROM observation
      WHERE scope = ${scope}
        AND valid_to IS NULL
        AND kind <> 'delete'
        ${filterExtras}
      ORDER BY entity, valid_from DESC, tx_time DESC
      LIMIT ${fetchN}
    `;
    const sortKey: (r: Row) => string | number = (() => {
      if (sortCol === '_global_id' || !sortCol) {
        return (r: Row) => r.entity;
      }
      if (sortCol === '_edited_at') {
        return (r: Row) => r.edited_at.getTime();
      }
      const col = sortCol;
      return (r: Row) => {
        const v = r.attrs?.[col] as unknown;
        if (v === null || v === undefined) return '';
        return typeof v === 'number' ? v : String(v);
      };
    })();
    rows.sort((a, b) => {
      const va = sortKey(a);
      const vb = sortKey(b);
      if (va < vb) return sortDirDesc ? 1 : -1;
      if (va > vb) return sortDirDesc ? -1 : 1;
      return 0;
    });

    const truncated = rows.length > limit;
    const kept = truncated ? rows.slice(0, limit) : rows;
    return {
      features: kept.map((r) => ({
        id: r.entity,
        properties: {
          ...(r.attrs ?? {}),
          _global_id: r.entity,
          _edited_by: r.edited_by,
          _edited_at: r.edited_at.toISOString(),
        },
      })),
      count: kept.length,
      truncated,
    };
  }

  /**
   * #30: union bbox of the named features in WGS84.  Used by the
   * AttributeTable's "Zoom to selected" affordance in server-paged
   * mode: /features-page strips geometry to keep the payload small,
   * so the client cannot compute a bbox locally and falls back to
   * this endpoint.  Returns null when none of the requested entities
   * have geometry (table layers, or selection of all-null-geom rows)
   * so the caller can surface a friendly "no extent" message.
   *
   * Geo-limit and boundary-clip filters are applied the same way
   * pageFeatures applies them, so a user with a clipped view of a
   * layer can't zoom to a feature outside their clip via this
   * endpoint.
   */
  async selectionExtent(args: {
    itemId: string;
    layerId: string;
    entityIds: string[];
    geoLimit?: GeoJsonGeometry;
    boundaryClip?: GeoJsonGeometry;
  }): Promise<[number, number, number, number] | null> {
    if (args.entityIds.length === 0) return null;
    // Bound user-supplied geometry size before it reaches PostGIS.
    validateGeoJson(args.geoLimit);
    validateGeoJson(args.boundaryClip);
    const scope = this.scope(args.itemId, args.layerId);
    // Same UUID coercion + cap as pageFeatures so the planner sees
    // a safe IN list.
    const ids = args.entityIds.slice(0, 1000);

    const filters: Prisma.Sql[] = [];
    if (args.geoLimit !== undefined) {
      const json = JSON.stringify(args.geoLimit);
      filters.push(
        Prisma.sql`AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326))`,
      );
    }
    if (args.boundaryClip !== undefined) {
      const json = JSON.stringify(args.boundaryClip);
      filters.push(
        Prisma.sql`AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326))`,
      );
    }
    const filterExtras =
      filters.length > 0 ? Prisma.join(filters, ' ') : Prisma.empty;

    // Pick the latest observation per entity (DISTINCT ON), then
    // aggregate ST_Extent over the resulting geometries.  The outer
    // SELECT uses ST_Extent which returns a `box2d`; we read its
    // bounds via ST_XMin/ST_YMin/ST_XMax/ST_YMax to get plain
    // numbers back to JS without a custom Prisma type.
    interface ExtentRow {
      xmin: number | null;
      ymin: number | null;
      xmax: number | null;
      ymax: number | null;
    }
    const rows = await this.prisma.$queryRaw<ExtentRow[]>`
      WITH current AS (
        SELECT DISTINCT ON (entity)
          entity, geom
        FROM observation
        WHERE scope = ${scope}
          AND valid_to IS NULL
          AND kind <> 'delete'
          AND geom IS NOT NULL
          AND entity = ANY(ARRAY[${Prisma.join(
            ids.map((id) => Prisma.sql`${id}::uuid`),
          )}])
          ${filterExtras}
        ORDER BY entity, valid_from DESC, tx_time DESC
      )
      SELECT
        ST_XMin(ST_Extent(geom)) AS xmin,
        ST_YMin(ST_Extent(geom)) AS ymin,
        ST_XMax(ST_Extent(geom)) AS xmax,
        ST_YMax(ST_Extent(geom)) AS ymax
      FROM current
    `;
    const r = rows[0];
    if (
      !r ||
      r.xmin === null ||
      r.ymin === null ||
      r.xmax === null ||
      r.ymax === null
    ) {
      return null;
    }
    return [r.xmin, r.ymin, r.xmax, r.ymax];
  }

  /**
   * Build a Mapbox Vector Tile for one layer at a given z/x/y. The
   * tile contains the layer's current-state features clipped to the
   * tile envelope.
   *
   * Why MVT instead of the listFeatures GeoJSON path:
   *
   *   Rendering a county-scale dataset (1.4M parcels) as a single
   *   GeoJSON FeatureCollection means the api serves hundreds of MB
   *   per request, the browser parses it on the main thread, and
   *   MapLibre re-tessellates the whole thing before drawing.
   *   Empirically that pegs both threads for tens of seconds and
   *   the page becomes unresponsive while the work runs. MVT is
   *   what AGO and every other production map stack uses for big
   *   layers: per-tile vector geometry, bbox-clipped, gzipped,
   *   cached by the browser. The same 1.4M polygons render
   *   incrementally as the user pans, at native MapLibre speed.
   *
   * The tile payload only includes the `_global_id` property so it
   * stays small. Popup / attribute access still routes through
   * listFeatures with `entity: <featureId>`; the click handler in
   * the web client fetches full attrs on demand.
   *
   * Authz model is the same as listFeatures: the caller has already
   * passed the canRead check via the controller. We do NOT plumb
   * lens-policy row filters through MVT yet; if a layer's lens
   * policy filters rows out, those rows would still leak in the
   * tile. Acceptable for v1 (lens policies aren't widely used);
   * tracked as a Phase-D follow-up. Geo-limit and boundary clip,
   * which are the much more common scoping mechanisms, ARE honored
   * via ST_Intersects clauses.
   *
   * Geometry-less ("table mode") sublayers return an empty MVT.
   */
  async mvtTile(args: {
    itemId: string;
    layerId: string;
    z: number;
    x: number;
    y: number;
    geoLimit?: GeoJsonGeometry;
    boundaryClip?: GeoJsonGeometry;
    isTable?: boolean;
    /**
     * Layer's declared field schema. Each entry's name is projected
     * into the MVT as a feature property so MapLibre expressions
     * (`['get', 'fieldName']` for labels, popups, and filters) can
     * resolve at render time. Without this the tile only carries
     * `_global_id` + geometry and every {{field}} resolves to null.
     * Caller should pass the layer's `fields[]` from its schema;
     * names must already be validated (the data_layer field-name
     * regex prevents SQL identifier injection).
     */
    fields?: Array<{ name: string; type?: string }>;
  }): Promise<Buffer> {
    if (args.isTable === true) {
      return Buffer.alloc(0);
    }
    // Bound user-supplied geometry size before it reaches PostGIS.
    validateGeoJson(args.geoLimit);
    validateGeoJson(args.boundaryClip);

    const scope = this.scope(args.itemId, args.layerId);
    const filters: Prisma.Sql[] = [];

    if (args.geoLimit !== undefined) {
      const json = JSON.stringify(args.geoLimit);
      filters.push(
        Prisma.sql`AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326))`,
      );
    }
    if (args.boundaryClip !== undefined) {
      const json = JSON.stringify(args.boundaryClip);
      filters.push(
        Prisma.sql`AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(${json}::text), 4326))`,
      );
    }
    const filterExtras =
      filters.length > 0 ? Prisma.join(filters, ' ') : Prisma.empty;

    // Build the per-field projection list. Each declared field gets
    // a `(attrs->>'name')::cast AS "name"` projection so it lands in
    // the MVT as a typed feature property. Identifier names must
    // not be parameterized in PostgreSQL bind protocol; Prisma.raw
    // is safe here because the field-name regex enforced by the
    // schema (`/^[A-Za-z_][A-Za-z0-9_]*$/`) is stricter than the
    // identifier whitelist we apply below. Belt-and-suspenders: we
    // reject any name that fails the regex even though the schema
    // path should have caught it upstream.
    const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
    const fieldProjections: Prisma.Sql[] = [];
    if (Array.isArray(args.fields)) {
      for (const f of args.fields) {
        if (!SAFE_NAME.test(f.name)) continue;
        const cast = sqlCastForFieldType(f.type);
        // `attrs` is the JSONB column on observation; `->>'name'`
        // extracts as text, then we cast where the schema declares
        // a numeric / boolean / date type so MapLibre's typed
        // expressions (e.g. `['>', ['get', 'pop'], 5]`) actually
        // work without string coercion warnings.
        fieldProjections.push(
          Prisma.raw(
            `(attrs->>'${f.name}')${cast} AS "${f.name}"`,
          ),
        );
      }
    }
    const fieldProjection =
      fieldProjections.length > 0
        ? Prisma.sql`, ${Prisma.join(fieldProjections, ', ')}`
        : Prisma.empty;
    // `currents` needs `attrs` available so the outer projection
    // can read it. Only include the JSONB column when we have at
    // least one field to project, to keep the row narrower in the
    // (rare) no-fields case.
    const currentsAttrs =
      fieldProjections.length > 0 ? Prisma.sql`, attrs` : Prisma.empty;

    // ST_TileEnvelope(z, x, y) returns the tile bbox in EPSG:3857
    // (Web Mercator). We bbox-filter on the geom column in 4326 by
    // transforming the envelope back to 4326 first; the && operator
    // uses the spatial index. ST_AsMVTGeom then transforms each
    // surviving geometry into the tile's local coordinate space
    // (4096-unit grid, with the 64-unit buffer that MapLibre needs
    // to avoid seams at tile edges).
    interface TileRow {
      mvt: Buffer;
    }
    const rows = await this.prisma.$queryRaw<TileRow[]>`
      WITH currents AS (
        SELECT DISTINCT ON (entity)
          entity,
          geom,
          kind
          ${currentsAttrs}
        FROM observation
        WHERE scope = ${scope}
          AND valid_to IS NULL
          AND geom IS NOT NULL
          AND geom && ST_Transform(ST_TileEnvelope(${args.z}::integer, ${args.x}::integer, ${args.y}::integer), 4326)
          ${filterExtras}
        ORDER BY entity, valid_from DESC, tx_time DESC
      ),
      tile_features AS (
        SELECT
          entity::text AS _global_id,
          ST_AsMVTGeom(
            ST_Transform(geom, 3857),
            ST_TileEnvelope(${args.z}::integer, ${args.x}::integer, ${args.y}::integer),
            4096,
            64,
            true
          ) AS geom
          ${fieldProjection}
        FROM currents
        WHERE kind <> 'delete'
      )
      SELECT
        COALESCE(ST_AsMVT(tile_features, 'features', 4096, 'geom'), '\\x'::bytea) AS mvt
      FROM tile_features
    `;
    const buf = rows[0]?.mvt;
    return buf instanceof Buffer ? buf : Buffer.alloc(0);
  }

  /**
   * Apply a Cedar-evaluated row filter to the engine's read output.
   * Pulled into its own method so the spec for Phase D can drive
   * it directly without rebuilding a full PostGIS query path.
   *
   * Honours the caller-supplied `spatialKeysFor` to resolve spatial
   * predicates upstream of the policy check; the policy then sees
   * a Set<string> of keys the feature qualifies for and evaluates
   * `.contains("assigned_area")` natively.
   */
  private applyLensPolicy(
    features: DataLayerFeature[],
    spec: ListFeaturesArgs['lensPolicy'],
  ): DataLayerFeature[] {
    if (!spec) return features;
    if (!spec.lens.policy || spec.lens.policy.trim().length === 0) {
      return features;
    }
    return features.filter((feature) => {
      const spatial = spec.spatialKeysFor
        ? spec.spatialKeysFor(feature)
        : [];
      return this.lensPolicy.checkFeature({
        user: spec.user,
        lens: spec.lens,
        feature: {
          entityId: feature.id,
          attrs: feature.properties as Record<string, unknown>,
          spatial,
        },
      });
    });
  }
}

/**
 * Sanitize a JSONB key name so it is safe to embed in a single-quoted
 * SQL literal. Keys flow from the v3 controller after schema-name
 * validation, so this is belt-and-suspenders against an upstream miss.
 * Replaces every character that is not `[a-zA-Z0-9_]` with `_`.
 */
function sanitizeJsonbKey(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, '_');
}

function requireId(id: string | undefined): string {
  if (id === undefined) {
    throw new Error('engine returned observation without id');
  }
  return id;
}

/**
 * Map a FeatureFieldType to a PostgreSQL cast suffix so the JSONB
 * `->>` text extraction lands in MVT with the right typed
 * property. Boolean and date are intentionally string-typed in
 * MVT (MVT itself doesn't have boolean/date wire types; MapLibre
 * compares them as strings), so we leave those uncast. Number
 * fields go through `::numeric` so `['>', ['get', 'pop'], 5]`
 * works without coercion warnings. Unknown / missing types fall
 * back to text.
 */
function sqlCastForFieldType(type: string | undefined): string {
  if (type === 'number') return '::numeric';
  return '';
}
