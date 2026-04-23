/**
 * Canonical shape stored in an Item's dataJson when `type = 'feature_service'`.
 *
 * Two storage strategies exist:
 *
 * **v1** — inline GeoJSON in `item.data.data`. Works for demos and small
 * datasets; hard cap around 25 MB upload / a few MB parsed JSON.
 *
 * **v2** — PostGIS table per item. `item.data` holds only metadata
 * (field schema, feature count, bbox, updatedAt). The actual geometry
 * and properties live in a table named `fs_<uuid_no_dashes>` in the
 * database. `GET /api/items/:id/geojson` streams from PostGIS with
 * optional `?bbox` and `?at` query parameters. Individual feature
 * CRUD (append, update, delete, history) lives at
 * `GET|POST|PATCH|DELETE /api/items/:id/features[/:fid]`.
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

/** v1: inline GeoJSON storage. */
export interface FeatureServiceDataV1 {
  version: 1;
  storageType?: never;
  fields: FeatureField[];
  data: {
    type: 'FeatureCollection';
    features: Array<{
      type: 'Feature';
      geometry: unknown;
      properties: Record<string, unknown>;
    }>;
  };
  updatedAt?: ISODateString;
}

/** v2: PostGIS-backed storage. `data.data` is absent; features live in the DB. */
export interface FeatureServiceDataV2 {
  version: 2;
  storageType: 'postgis';
  fields: FeatureField[];
  featureCount: number;
  /** [minX, minY, maxX, maxY] in EPSG:4326. Null when the table is empty. */
  bbox: [number, number, number, number] | null;
  updatedAt?: ISODateString;
}

export type FeatureServiceData = FeatureServiceDataV1 | FeatureServiceDataV2;

export const DEFAULT_FEATURE_SERVICE: FeatureServiceDataV1 = {
  version: 1,
  fields: [],
  data: { type: 'FeatureCollection', features: [] },
};

// ---------------------------------------------------------------------------
// Feature API types (used by portal-web and field-app)
// ---------------------------------------------------------------------------

/** A single GeoJSON feature returned by the features REST API. */
export interface FeatureRecord {
  type: 'Feature';
  /** Stable UUID across all versions of this feature. */
  id: string;
  geometry: unknown;
  properties: Record<string, unknown>;
  _meta?: {
    gid: number;
    validFrom: ISODateString;
    /** null means the feature is current. */
    validTo?: ISODateString;
    createdBy: string;
    createdAt: ISODateString;
    editedBy: string;
    editedAt: ISODateString;
  };
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: FeatureRecord[];
}

/** Body for POST /items/:id/features (append one or more features). */
export interface AppendFeaturesInput {
  features: Array<{
    /** Client-generated UUID — provide for offline-created features so
     *  parent/child GUIDs established offline survive the sync. */
    globalId?: string;
    geometry?: unknown;
    properties?: Record<string, unknown>;
  }>;
}

/** Body for PATCH /items/:id/features/:fid (partial update). */
export interface UpdateFeatureInput {
  geometry?: unknown;
  properties?: Record<string, unknown>;
}
