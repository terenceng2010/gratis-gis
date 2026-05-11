// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Canonical shape stored in an Item's data_json when
 * `type = 'geocoding_service'` (#74).
 *
 * A geocoding_service item wraps a `data_layer` and exposes a
 * text-search endpoint that returns ranked candidate features. The
 * `/api/portal/geocode/:itemId?text=` runtime endpoint reads this
 * config, fans the query out across the configured `searchFields`
 * using pg_trgm similarity, and returns features with geometry +
 * a composed label.
 *
 * Why an item rather than a "publish as geocoder" toggle on the
 * data layer itself: one parcels layer can legitimately back
 * multiple geocoders (one for address search, one for parcel-id
 * lookup) that share data but expose different fields + scoring;
 * and the geocoder needs to share independently of the underlying
 * data layer (a viewer might be allowed to geocode but not browse
 * the full parcel set).
 *
 * Per-share authorization rules:
 *
 *   - To run a geocode query the caller needs `view` access on
 *     the geocoding_service item itself.
 *   - The runtime ALSO enforces the underlying data_layer's
 *     access tier and share-geo-limit clips at query time, so a
 *     viewer who has the geocoder shared but not the data layer
 *     can still call /geocode but only sees candidates from the
 *     subset of features they could read directly. Sharing a
 *     geocoder is not a back-door around the data layer's authz.
 */
import type { ISODateString } from './ids';

export type GeocodingServiceDataVersion = 1;

/**
 * One configured search field. The geocoder builds a UNION of
 * per-field similarity queries against `attrs->>{name}` so a single
 * input string can match any of the listed fields. `weight` shapes
 * the ranking when the same row matches against multiple fields;
 * a parcel that hits on both `street_address` (weight 5) and
 * `owner_name` (weight 1) ranks higher than one that only hits the
 * owner. Default weight is 1.
 */
export interface GeocodingSearchField {
  /** Field name on the underlying data_layer. Must exactly match a
   *  field in the layer schema (no implicit casing / aliasing) so
   *  the query path can read `attrs->>{name}`. */
  name: string;
  /** 1-10 (clamped server-side). Multiplied into the pg_trgm
   *  similarity score so high-confidence fields rank above
   *  low-confidence matches. */
  weight?: number;
  /** Optional display label for the runtime picker UI. Defaults to
   *  `name`. Stored alongside so apps consuming the geocoder don't
   *  have to fetch the layer schema just to render the input
   *  field's label. */
  label?: string;
}

/**
 * Optional spatial constraint applied to every query. `layer-bbox`
 * uses the underlying data_layer's cached bbox, which is the typical
 * "this geocoder only covers West Virginia" use-case. `none` accepts
 * any candidate. Explicit `[w, s, e, n]` lets the author scope to a
 * specific region (e.g. a single county) that's narrower than the
 * layer's full extent.
 */
export type GeocodingBboxFilter =
  | 'layer-bbox'
  | 'none'
  | { wsen: [number, number, number, number] };

export interface GeocodingServiceData {
  version: GeocodingServiceDataVersion;
  /** UUID of the data_layer item that backs this geocoder. */
  sourceLayerId: string;
  /**
   * Sublayer id within the source data_layer. v3 data_layer items
   * carry multiple layers; the geocoder targets exactly one.
   * Required when the source is v3 (which is everything modern);
   * the API rejects geocoding_service items whose source is v3 but
   * which omit this field.
   */
  sourceSublayerId?: string;
  /** Search fields, in author-curated order. The order is mostly
   *  cosmetic; ranking is by score not by field order. */
  searchFields: GeocodingSearchField[];
  /** Field names included in each candidate's `attributes` payload
   *  so callers can render details beyond the label / geom. When
   *  unset, returns just the fields in `searchFields`. */
  resultFields?: string[];
  /**
   * Cap returned candidates per query. Server clamps to a hard max
   * (currently 50). Default 10 matches the typical autocomplete UX.
   */
  candidateLimit?: number;
  /**
   * Minimum similarity score (0-1). Candidates below this are
   * dropped. Defaults to 0.1 which catches typo-level variations
   * but filters obvious mismatches. 0.3+ for "match must be close";
   * 0 to accept everything pg_trgm finds.
   */
  minScore?: number;
  /** Spatial constraint applied to every query. */
  bboxFilter?: GeocodingBboxFilter;
  /** Format string for the composed candidate `label`. Supports
   *  `{fieldName}` placeholders that the runtime replaces with the
   *  feature's attribute values. Defaults to joining the matched
   *  searchFields with a comma. Example for parcels:
   *  `"{owner_name} ({street_address})"`. */
  labelTemplate?: string;
  probedAt?: ISODateString;
}

export const DEFAULT_GEOCODING_SERVICE: GeocodingServiceData = {
  version: 1,
  sourceLayerId: '',
  searchFields: [],
  candidateLimit: 10,
  minScore: 0.1,
  bboxFilter: 'layer-bbox',
};

export function isGeocodingServiceData(
  value: unknown,
): value is GeocodingServiceData {
  if (!value || typeof value !== 'object') return false;
  const v = value as {
    version?: unknown;
    sourceLayerId?: unknown;
    searchFields?: unknown;
  };
  if (v.version !== 1) return false;
  if (typeof v.sourceLayerId !== 'string') return false;
  if (!Array.isArray(v.searchFields)) return false;
  return v.searchFields.every(
    (f) =>
      f !== null &&
      typeof f === 'object' &&
      typeof (f as { name?: unknown }).name === 'string',
  );
}

/**
 * One candidate returned by /api/portal/geocode/:itemId. The runtime
 * composes `label` from the configured labelTemplate (or searchFields
 * join when no template is set) so callers don't need to know the
 * underlying schema. `geom` is GeoJSON; for non-point layers the
 * runtime returns a centroid so map viewers can pan-zoom without
 * needing to render the original polygon.
 */
export interface GeocodingCandidate {
  /** Stable feature id from the underlying data_layer (the entity
   *  UUID in observation-engine terms). */
  featureId: string;
  /** Similarity score, 0-1. Higher is better. */
  score: number;
  /** Composed display label per the geocoder's labelTemplate. */
  label: string;
  /** Point geometry: actual point for point layers; centroid for
   *  line/polygon layers so the map can zoom to the candidate. */
  geom: { type: 'Point'; coordinates: [number, number] };
  /** Feature attributes restricted to `resultFields`, or the
   *  searchFields when resultFields is unset. */
  attributes: Record<string, unknown>;
}
