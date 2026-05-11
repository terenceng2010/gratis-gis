// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Canonical shape stored in an Item's data_json when
 * `type = 'tile_layer'` (#179).
 *
 * A tile_layer item wraps a single pre-rendered tile container
 * (currently PMTiles only; MBTiles + TPK/TPKX are documented as
 * follow-ups). The uploaded bytes live in MinIO; the item carries
 * the storage key + metadata lifted from the file header at
 * upload time so render-time consumers don't have to re-parse
 * the header per request.
 *
 * Why PMTiles as the only v1 format:
 *
 *   - Open spec (CC0), single file, HTTP-range-request friendly.
 *     MinIO range-serves the file directly; no per-tile compute
 *     on our side. MapLibre's pmtiles protocol plugin reads the
 *     file with range requests from the client.
 *   - MBTiles requires SQLite open + per-tile query for every
 *     tile served. Order-of-magnitude more compute and a
 *     dedicated server process. We can ingest MBTiles by
 *     converting to PMTiles at upload, but that conversion is
 *     follow-up scope; for v1 we accept PMTiles directly.
 *   - TPK / TPKX are Esri-proprietary zip-with-metadata. Their
 *     internal format wraps PNG / JPG tiles and an Esri-shaped
 *     JSON conf file. Worth supporting but needs its own
 *     extraction pipeline.
 *   - COG (Cloud-Optimized GeoTIFF) is the right answer for
 *     RAW imagery input that we'd tile on-the-fly. Not a tile
 *     container; lives in the separate "generate tile cache
 *     from imagery" surface (also follow-up).
 *
 * Once uploaded, the tile_layer is consumable as a basemap by
 * creating a basemap item with `kind: 'tile-url'` and the
 * tile_layer's `tileUrl` value (which the API exposes as a
 * pmtiles:// URL pointing at the API's proxy endpoint).
 */
import type { ISODateString } from './ids';

/**
 * Recognized container formats AT REST in MinIO. After the
 * upload + conversion pipeline runs, every tile_layer's file is
 * stored as PMTiles regardless of what the user uploaded; the
 * `originalFormat` field below records what they sent us.
 *
 * We unify on PMTiles at rest because the serving path
 * (range-request friendly, zero per-tile compute) only works for
 * PMTiles. MBTiles + zipped XYZ ingestion exists for user
 * convenience, not because we'd ever serve those formats
 * directly.
 */
export type TileLayerFormat = 'pmtiles';

/**
 * Container formats accepted at upload. The ingest path converts
 * non-pmtiles inputs to pmtiles via the pmtiles Go CLI before
 * persisting. TPK / TPKX are documented out of v1 ingest because
 * Esri's bundle format needs its own extraction pipeline.
 */
export type TileLayerOriginalFormat =
  | 'pmtiles'
  | 'mbtiles'
  | 'xyz-zip';

/** Raster vs vector tile content. Lifted from the PMTiles header
 *  at upload time; consumers read this to decide whether to
 *  treat the source as a `raster` or `vector` MapLibre source. */
export type TileLayerKind = 'raster' | 'vector';

export type TileLayerDataVersion = 1;

export interface TileLayerData {
  version: TileLayerDataVersion;
  /** Container format stored in MinIO. Always 'pmtiles' after
   *  ingest (regardless of original upload format). */
  format: TileLayerFormat;
  /**
   * Container format the user originally uploaded. Surfaced on
   * the detail page so the author can see whether a conversion
   * ran. Missing on items that pre-date this field; treat
   * absence as 'pmtiles' for backward compat.
   */
  originalFormat?: TileLayerOriginalFormat;
  /** Original upload filename before conversion (e.g.
   *  "wv-parcels.mbtiles"). Useful for re-download / debugging. */
  originalFileName?: string;
  /** Size of the original upload in bytes. May differ from
   *  sizeBytes when the conversion shrinks/grows the file. */
  originalSizeBytes?: number;
  /** Milliseconds spent in the conversion step. Surfaced on the
   *  detail page so authors can see the one-time conversion cost
   *  separately from the upload time. */
  conversionMs?: number;
  /** Raster vs vector content. Lifted from the PMTiles header. */
  kind: TileLayerKind;
  /** MinIO object key. Used for delete cleanup. */
  storageKey: string;
  /** Public MinIO URL for the file. MapLibre's pmtiles plugin
   *  range-reads this URL directly; no per-tile API hop. */
  storageUrl: string;
  /** Original upload filename for display + Content-Disposition
   *  on the download affordance. */
  fileName: string;
  /** Total uploaded size in bytes. Drives the file-size readout
   *  on the detail page and the housekeeping storage card. */
  sizeBytes: number;
  /** When the upload completed. Distinct from item.updatedAt
   *  because a re-upload action would keep updatedAt aligned but
   *  we want to know the bytes' age separately. */
  uploadedAt: ISODateString;

  // -------------------- metadata from the PMTiles header --------------------

  /** Minimum zoom level present in the cache. */
  minZoom?: number;
  /** Maximum zoom level present in the cache. */
  maxZoom?: number;
  /** EPSG:4326 bbox of the cached coverage [west, south, east, north]. */
  bbox?: [number, number, number, number];
  /** Suggested map center longitude. */
  centerLng?: number;
  /** Suggested map center latitude. */
  centerLat?: number;
  /** Suggested initial zoom. */
  centerZoom?: number;
  /**
   * Tile content type. PMTiles internal type ints map to the
   * tokens we store: 'mvt' (vector), 'png', 'jpg', 'webp', 'avif'.
   * Used by the runtime to pick the right MapLibre source +
   * layer types.
   */
  tileType?: 'mvt' | 'png' | 'jpg' | 'webp' | 'avif' | 'unknown';
  /** Attribution string from the PMTiles header, when set by
   *  whoever built the cache. Surfaced as the basemap
   *  attribution when the layer is used as a basemap. */
  attribution?: string;
  /** Human-readable name from the PMTiles header. */
  name?: string;
  /** Description string from the PMTiles header. */
  description?: string;

  // ----------------------------- runtime URL --------------------------------

  /**
   * The pmtiles:// URL the basemap editor / map renderer uses to
   * consume this tile layer. Server fills this in after upload:
   * `pmtiles://<api-base>/api/portal/tile-layer/<itemId>/file`.
   *
   * Stored on the item so the basemap editor's "Use as basemap"
   * affordance can hand it straight to the user as a copyable
   * URL without an extra api round-trip.
   */
  tileUrl?: string;
}

export const DEFAULT_TILE_LAYER: TileLayerData = {
  version: 1,
  format: 'pmtiles',
  kind: 'raster',
  storageKey: '',
  storageUrl: '',
  fileName: '',
  sizeBytes: 0,
  uploadedAt: new Date(0).toISOString() as ISODateString,
};

export function isTileLayerData(value: unknown): value is TileLayerData {
  if (!value || typeof value !== 'object') return false;
  const v = value as {
    version?: unknown;
    format?: unknown;
    storageKey?: unknown;
  };
  if (v.version !== 1) return false;
  if (v.format !== 'pmtiles') return false;
  if (typeof v.storageKey !== 'string') return false;
  return true;
}
