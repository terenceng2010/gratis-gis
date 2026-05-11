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

/**
 * Where this geocoder's candidates come from. Two modes:
 *
 *   - 'internal': search the org's own PostGIS data_layer using
 *     pg_trgm word_similarity. The author picks a source layer +
 *     fields + weights. This is the use-your-own-data path.
 *
 *   - 'external-arcgis': proxy to a public ArcGIS GeocodeServer
 *     (e.g. a state-published statewide locator like the WV WVU
 *     Composite locator). The author pastes the URL; the runtime
 *     forwards findAddressCandidates requests and reshapes the
 *     response into the candidate shape maps consume. No data
 *     layer needed; no per-field indexes; cap on use is whatever
 *     the upstream service allows.
 *
 * Items written before this field existed default to 'internal'
 * (matches the v1 behavior of geocoding_service); the read path
 * treats `undefined` as 'internal' for backward compat.
 */
export type GeocodingServiceMode = 'internal' | 'external-arcgis';

/**
 * Address-field snapshot for external ArcGIS geocoders. Lifted
 * from the server's `addressFields[]` at probe time so the map
 * search UI can render the right inputs without re-hitting
 * `?f=json` on every query. Mirrors ArcgisGeocodeFieldSnapshot
 * from the legacy Connected Service path.
 */
export interface ExternalGeocodeAddressField {
  name: string;
  alias?: string;
  required?: boolean;
}

export interface GeocodingServiceData {
  version: GeocodingServiceDataVersion;
  /**
   * Which source this geocoder uses. When omitted, treat as
   * 'internal' (backward compat for items created before this
   * field shipped).
   */
  mode?: GeocodingServiceMode;

  // -------------------- internal-mode fields --------------------
  // Required when mode === 'internal'; ignored otherwise. Left
  // non-optional in the shared-types interface so existing
  // internal-mode call sites continue to typecheck unchanged.

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

  // -------------------- external-arcgis-mode fields --------------------
  // Required when mode === 'external-arcgis'; ignored otherwise.

  /** Base URL of the ArcGIS GeocodeServer (e.g.
   *  `https://services.wvgis.wvu.edu/.../WV_Composite/GeocodeServer`).
   *  The runtime appends `/findAddressCandidates?...&f=json`. */
  externalUrl?: string;
  /** Human-readable name lifted from the GeocodeServer's
   *  `serviceDescription` / `mapName` at probe time. */
  externalServiceTitle?: string;
  /** Multi-line address fields the upstream server accepts. */
  externalAddressFields?: ExternalGeocodeAddressField[];
  /** Single-line address field name, when the server advertises
   *  one. Most modern locators do; this is what the search bar
   *  posts the user's query into. */
  externalSingleLineFieldName?: string;
  /** ISO-style country codes the locator indexes. Surfaced on the
   *  detail page so the author can verify coverage. */
  externalSupportedCountries?: string[];
  /** Capabilities the upstream advertises (geocode,
   *  reversegeocode, suggest, ...). */
  externalCapabilities?: string[];
  /** Attribution string the upstream advertises in `copyrightText`.
   *  Surfaced on the search bar's footer when this geocoder is
   *  the picked source. */
  externalAttribution?: string;
}

export const DEFAULT_GEOCODING_SERVICE: GeocodingServiceData = {
  version: 1,
  mode: 'internal',
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
    mode?: unknown;
    sourceLayerId?: unknown;
    searchFields?: unknown;
    externalUrl?: unknown;
  };
  if (v.version !== 1) return false;
  // Two valid shapes: internal (sourceLayerId + searchFields) and
  // external-arcgis (externalUrl). Either is enough.
  const mode = typeof v.mode === 'string' ? v.mode : 'internal';
  if (mode === 'external-arcgis') {
    return typeof v.externalUrl === 'string' && v.externalUrl.length > 0;
  }
  // internal (or missing mode)
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
