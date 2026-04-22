/**
 * Canonical shape stored in an Item's dataJson when `type = 'feature_service'`.
 *
 * v1 strategy: hold the feature data inline as a GeoJSON FeatureCollection.
 * This is a conscious simplification — inline storage scales only as far
 * as the 1 MB-or-so dataJson soft cap reasonably handles, and has no
 * query optimization, tile cache, or spatial index beyond what MapLibre
 * does client-side. When the PostGIS-backed storage path ships, the
 * same item type swaps this payload for a server-side reference; the
 * HTTP contract (`GET /api/items/:id` returns a GeoJSON-shaped `data`)
 * stays stable so downstream consumers (web maps, dashboards, the
 * field app) don't need a rewrite.
 */

import type { ISODateString } from './ids';

/** Authoritative column types. Keep synced with the form-schema package. */
export type FeatureFieldType = 'string' | 'number' | 'boolean' | 'date';

export interface FeatureField {
  name: string;
  type: FeatureFieldType;
  /** UI-facing display name; falls back to `name` if blank. */
  label: string;
  nullable: boolean;
}

/**
 * A typed row shape would be nice here; it comes in once we generate
 * TS types from field definitions. For now, GeoJSON properties stay
 * loose.
 */
export interface FeatureServiceData {
  version: 1;
  fields: FeatureField[];
  /**
   * The feature data itself. Must be a GeoJSON FeatureCollection. The
   * editor surfaces tools to replace this payload; downstream viewers
   * can assume `type === 'FeatureCollection'` and iterate `features`.
   */
  data: {
    type: 'FeatureCollection';
    features: Array<{
      type: 'Feature';
      geometry: unknown;
      properties: Record<string, unknown>;
    }>;
  };
  /**
   * When the payload was last ingested. Useful for display and for
   * tile-cache invalidation once server-side storage lands.
   */
  updatedAt?: ISODateString;
}

export const DEFAULT_FEATURE_SERVICE: FeatureServiceData = {
  version: 1,
  fields: [],
  data: { type: 'FeatureCollection', features: [] },
};
