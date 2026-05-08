// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lens: the engine's primitive for "a saved query plus a render
// spec." A lens collapses several familiar concepts -- feature
// service, definition query, web map layer, dashboard tile -- into
// one shape, so that the same primitive can produce a tile, a
// JSON table, a chart payload, or a stream depending on its
// `render.kind`.
//
// See `docs/architecture/observation-log-engine.md` for the full
// design. This file is intentionally narrow: it defines the wire
// shape, type guards, and a small set of builders. The actual query
// planning + rendering live in `apps/portal-api/src/engine/`.

import type { GeoJsonGeometry } from './types.js';

/**
 * A geometry envelope, [west, south, east, north] in WGS84.
 * Reused across `LensQuery.bbox` and `LensView.viewport`.
 */
export type BBox = [number, number, number, number];

/**
 * What to read from the engine. The query is independent of how
 * the result will be rendered; the same query can power a map
 * tile, a CSV download, and a dashboard scalar.
 *
 * v1 supports the slice that data_layer reads need; attribute
 * predicate trees and aggregations land alongside dashboards
 * (Phase 4).
 */
export interface LensQuery {
  /**
   * Required. The engine scope to read from, e.g.
   * `data_layer:abc123:lyr_xyz`. A lens that reads from multiple
   * scopes lists them all here; the engine UNIONs the results
   * and orders them by `validFrom DESC` so the most recent
   * truth wins per entity.
   */
  scopes: string[];
  /**
   * Optional. Bitemporal point in time. ISO-8601 string. Defaults
   * to "now" at read time. A lens with a fixed `asOf` is a
   * frozen-in-time snapshot; clients can still override via the
   * `?asOf=` query param if the policy permits it.
   */
  asOf?: string;
  /**
   * Optional spatial filter. Reads only return features whose
   * geometry intersects this envelope. Note that the lens itself
   * stores the filter; the engine adds any per-share `geoLimit`
   * on top, intersecting both at evaluation time.
   */
  bbox?: BBox;
  /**
   * Optional attribute predicate. Single-clause for v1, mirroring
   * the existing `MapLayerFilter` shape. A multi-clause builder
   * can land in Phase 4 without changing the engine wire shape;
   * the runtime treats `attrFilter` as opaque JSON.
   */
  attrFilter?: LensAttrFilter | null;
  /**
   * Optional cap on returned rows. Defaults to a renderer-specific
   * sane maximum (e.g. 50,000 for `geojson`, 1,000 for
   * `geojson_table`). Caps are advisory; the engine may impose
   * tighter limits per policy.
   */
  limit?: number;
}

/**
 * Single-predicate attribute filter. A v1 placeholder; the shape
 * is wide enough that the existing data_layer renderer code can
 * map it directly to its current filter pipeline.
 */
export interface LensAttrFilter {
  field: string;
  op:
    | 'eq'
    | 'neq'
    | 'lt'
    | 'lte'
    | 'gt'
    | 'gte'
    | 'in'
    | 'contains'
    | 'startsWith'
    | 'isNull'
    | 'isNotNull';
  /** RHS for binary ops. Omitted for `isNull` / `isNotNull`. */
  value?: string | number | boolean | Array<string | number | boolean> | null;
}

/**
 * How the lens result is rendered. `kind` selects a renderer;
 * everything else is renderer-specific config. Renderers live in
 * `apps/portal-api/src/engine/renderers/` (Phase 4); v1 ships
 * `geojson`, `geojson_table`, `mvt`, `scalar_json`. Adding a
 * renderer is one file plus a case in the dispatcher.
 */
export type LensRender =
  | LensRenderGeoJson
  | LensRenderGeoJsonTable
  | LensRenderMvt
  | LensRenderScalar;

export interface LensRenderGeoJson {
  kind: 'geojson';
  /** Optional pointer into the existing MapLayer style block. */
  styleRef?: string;
}

export interface LensRenderGeoJsonTable {
  kind: 'geojson_table';
  /** Column ordering for the attribute table view. */
  columns?: string[];
}

export interface LensRenderMvt {
  kind: 'mvt';
  /** Optional minzoom / maxzoom clamp. Defaults to MapLibre defaults. */
  minZoom?: number;
  maxZoom?: number;
}

export interface LensRenderScalar {
  kind: 'scalar_json';
  /** Aggregation expression, e.g. `count(*)`, `sum(attrs->>'cost')`. */
  expr: string;
}

/**
 * Cache hint. `eager` recomputes on every write, `lazy`
 * invalidates on write and recomputes on next read,
 * `scheduled` refreshes on a TTL. New lenses default to no MV
 * (live read every time); only set this when you have a reason.
 */
export type LensCacheHint =
  | { mode: 'eager' }
  | { mode: 'lazy' }
  | { mode: 'scheduled'; ttlSeconds: number };

/**
 * Saved viewport for map-shaped lenses. Equivalent to the camera
 * state on a map item. Map renderers honour this when no client
 * viewport override is supplied.
 */
export interface LensView {
  center: [number, number];
  zoom: number;
  bearing?: number;
  pitch?: number;
  /** Optional hard envelope override (overrides center/zoom). */
  viewport?: BBox;
}

/**
 * The full lens. v1 stores these inline in items (a `map` item's
 * `data.layers[]` becomes a list of lenses); the `lens` table in
 * the engine substrate goes in alongside Phase 4 once dashboards
 * land.
 */
export interface Lens {
  /** UUIDv7. Stable across renames. */
  id: string;
  name: string;
  description?: string;
  query: LensQuery;
  render: LensRender;
  view?: LensView;
  cache?: LensCacheHint;
  /**
   * Cedar policy text. Opaque to the engine in v1: a coarse
   * org-membership check from the JWT is applied unconditionally.
   * Phase A wiring of cedar-policy parses this as a real policy
   * set; until then it's preserved verbatim so a policy authored
   * during the v1 window survives the upgrade.
   */
  policy?: string;
}

/**
 * Type guard. Use sparingly -- in TS callers the
 * narrow-by-discriminant on `render.kind` is preferred.
 */
export function isLens(value: unknown): value is Lens {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string') return false;
  if (typeof v.name !== 'string') return false;
  const q = v.query as Record<string, unknown> | undefined;
  if (!q || !Array.isArray(q.scopes)) return false;
  const r = v.render as Record<string, unknown> | undefined;
  if (!r || typeof r.kind !== 'string') return false;
  return true;
}

/**
 * Make sure a geometry's bbox is well-formed for use as a
 * `LensQuery.bbox`. Pure helper; lives here so callers don't
 * have to import a geometry library to build a lens.
 */
export function bboxFromGeometry(geom: GeoJsonGeometry): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (coord: number[]) => {
    const [x, y] = coord;
    if (typeof x !== 'number' || typeof y !== 'number') return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  const walk = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number') {
      visit(coords as number[]);
      return;
    }
    for (const inner of coords) walk(inner);
  };
  walk((geom as { coordinates: unknown }).coordinates);
  if (!Number.isFinite(minX)) {
    throw new Error('bboxFromGeometry: geometry has no usable coordinates');
  }
  return [minX, minY, maxX, maxY];
}
