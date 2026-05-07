// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Canonical shape stored in an Item's data_json when `type = 'service'`
 * (#304).
 *
 * A "Connected service" item is a thin pointer at a remote spatial
 * service. Replaces the four older protocol-specific item types
 * (arcgis_service, wms_service, wfs_service) and absorbs the new
 * one (WMTS) under a single discriminated union keyed on `protocol`.
 *
 * Why one type:
 *
 *   - The authoring workflow is identical: paste URL, probe, pick
 *     layers, save. The wizard auto-detects the protocol from the
 *     URL response so the user doesn't have to know whether they're
 *     pointing at a MapServer or a WMS upfront.
 *   - Adding the next protocol (OGC API Features, OGC API Tiles,
 *     Esri ImageServer, MVT vector tilesets, etc.) is a new
 *     `protocol` value plus a probe shim, not a new item type +
 *     wizard branch + detail page.
 *   - Add Data dialogs and the items list show one "Service" facet
 *     instead of four; an optional `protocol` sub-filter covers the
 *     power-user case ("show me only my WFS services").
 *
 * Migration: legacy arcgis_service / wms_service / wfs_service items
 * stay readable through their existing detail pages until a one-shot
 * converter writes them as `service` rows. New wizard creates
 * `service` items going forward.
 *
 * Per-protocol fields live on each variant rather than in a free-form
 * `meta` blob so consumers get exhaustive switching at the type level.
 */
import type { ISODateString } from './ids';

/** Each protocol value is the wire identifier the runtime branches on
 *  to render the source. Keep these snake_case for JSON cleanliness
 *  and to leave room for future protocols (`oapi_features`,
 *  `oapi_tiles`, `mvt`, etc.). */
export type ServiceProtocol =
  | 'arcgis_map'
  | 'arcgis_feature'
  | 'arcgis_image'
  | 'wms'
  | 'wfs'
  | 'wmts';

/**
 * Per-layer snapshot captured at probe time. The required fields
 * (`name`, `title`) are the human-friendly identifiers every protocol
 * advertises; per-protocol extras live alongside as optional fields
 * because populating a discriminated layer type per protocol is more
 * code than the runtime needs (the renderer already branches on the
 * outer protocol).
 */
export interface ServiceLayerSnapshot {
  /** Canonical id used by the runtime when constructing requests:
   *   - arcgis_*: the integer sublayer id stringified (e.g. "0").
   *   - wms     : the WMS Layer Name.
   *   - wfs     : the typeName (may include namespace prefix).
   *   - wmts    : the WMTS layer Identifier. */
  name: string;
  /** Display label from the GetCapabilities Title / ArcGIS layer name.
   *  Falls back to `name` when the server didn't advertise a Title. */
  title: string;
  /** Spatial extent in WGS84 lng/lat when the server reported one. */
  bbox?: [number, number, number, number];
  // ----- Per-protocol extras. Only one protocol's fields are
  // meaningful per layer; the rest stay unset. -----
  /** ArcGIS feature/map: the per-sublayer geometry kind, when
   *  geometry-bearing. Tables omit this field. */
  geometryType?: string;
  /** WMS / WMTS: the server-advertised default style identifier. */
  defaultStyle?: string;
  /** WMTS: the TileMatrixSet identifier this layer is published for.
   *  Many WMTS layers advertise multiple matrix sets; the picker
   *  records the one chosen at create time. */
  tileMatrixSet?: string;
  /** WMTS: tile image format (image/png, image/jpeg). */
  format?: string;
}

interface ServiceDataBase {
  version: 1;
  /** Service base URL with the GetCapabilities / REST root path. No
   *  trailing slash, no query string. */
  url: string;
  /** Curated subset of probed layers. Indices into `layers[]`. When
   *  unset, consumers should treat as "all selected" for backward
   *  compatibility (matches the legacy ExternalLayerSelection
   *  contract). */
  selectedLayerIds?: number[];
  /** Index into layers[] picking the default layer when an app or
   *  map consumes this service without a sublayer hint. */
  defaultLayerIndex?: number;
  layers: ServiceLayerSnapshot[];
  /** Service-level extent (union of layer bboxes when the server
   *  didn't advertise a top-level one). Used by the detail page
   *  zoom-to-extent affordance and the housekeeping recompute pass. */
  bbox?: [number, number, number, number];
  /** Service-level title harvested from the GetCapabilities document
   *  (or the ArcGIS REST service root). Surfaced on the detail page
   *  next to the URL. */
  serviceTitle?: string;
  probedAt?: ISODateString;
  /** Whether the service requires a stored credential. Mirrors the
   *  arcgis_service flag; set during probe when an unauthenticated
   *  request returned 401 / a token-required error and the user
   *  supplied credentials to complete the probe. */
  requiresAuth?: boolean;
}

export interface ArcgisMapService extends ServiceDataBase {
  protocol: 'arcgis_map';
}

export interface ArcgisFeatureService extends ServiceDataBase {
  protocol: 'arcgis_feature';
}

export interface ArcgisImageService extends ServiceDataBase {
  protocol: 'arcgis_image';
}

export interface WmsService extends ServiceDataBase {
  protocol: 'wms';
  protocolVersion: '1.1.1' | '1.3.0';
  /** Output format the renderer should ask for. PNG is the safe
   *  default; some servers serve only image/jpeg. */
  format?: string;
  /** Whether to request transparent tiles. Most consumers want true. */
  transparent?: boolean;
  /** Coordinate reference system. EPSG:3857 is standard for slippy-map
   *  basemaps; data overlays often need EPSG:4326. */
  crs?: string;
}

export interface WfsService extends ServiceDataBase {
  protocol: 'wfs';
  protocolVersion: '1.1.0' | '2.0.0';
  /** Output format for GetFeature. application/json (GeoJSON) is the
   *  modern default; GML2 / GML3 are fallbacks for older servers. */
  outputFormat?: string;
}

export interface WmtsService extends ServiceDataBase {
  protocol: 'wmts';
  protocolVersion: '1.0.0';
  /** Default TileMatrixSet for the service. Per-layer overrides live
   *  on each layer's `tileMatrixSet`. */
  defaultTileMatrixSet?: string;
}

/** The full discriminated union. Consumers exhaustively switch on
 *  `protocol`. */
export type ServiceData =
  | ArcgisMapService
  | ArcgisFeatureService
  | ArcgisImageService
  | WmsService
  | WfsService
  | WmtsService;

/**
 * Default scaffolds keyed by protocol. The wizard picks one of these
 * after the auto-detect probe identifies the protocol; every required
 * field carries a sane initial value so the rest of the create flow
 * doesn't have to special-case "did the user already configure X".
 */
export const DEFAULT_SERVICE: Record<ServiceProtocol, ServiceData> = {
  arcgis_map: {
    version: 1,
    protocol: 'arcgis_map',
    url: '',
    layers: [],
  },
  arcgis_feature: {
    version: 1,
    protocol: 'arcgis_feature',
    url: '',
    layers: [],
  },
  arcgis_image: {
    version: 1,
    protocol: 'arcgis_image',
    url: '',
    layers: [],
  },
  wms: {
    version: 1,
    protocol: 'wms',
    url: '',
    protocolVersion: '1.3.0',
    format: 'image/png',
    transparent: true,
    crs: 'EPSG:3857',
    layers: [],
  },
  wfs: {
    version: 1,
    protocol: 'wfs',
    url: '',
    protocolVersion: '2.0.0',
    outputFormat: 'application/json',
    layers: [],
  },
  wmts: {
    version: 1,
    protocol: 'wmts',
    url: '',
    protocolVersion: '1.0.0',
    layers: [],
  },
};

/** Human-friendly label for a protocol value. Used in the wizard's
 *  post-probe confirmation, the detail page header, and the items
 *  list facet. */
export function serviceProtocolLabel(p: ServiceProtocol): string {
  switch (p) {
    case 'arcgis_map':
      return 'ArcGIS Map Service';
    case 'arcgis_feature':
      return 'ArcGIS Feature Service';
    case 'arcgis_image':
      return 'ArcGIS Image Service';
    case 'wms':
      return 'WMS';
    case 'wfs':
      return 'WFS';
    case 'wmts':
      return 'WMTS';
    default:
      return p;
  }
}

/** Narrowing type guard. */
export function isServiceData(value: unknown): value is ServiceData {
  if (!value || typeof value !== 'object') return false;
  const v = value as { version?: unknown; protocol?: unknown };
  if (v.version !== 1) return false;
  return (
    v.protocol === 'arcgis_map' ||
    v.protocol === 'arcgis_feature' ||
    v.protocol === 'arcgis_image' ||
    v.protocol === 'wms' ||
    v.protocol === 'wfs' ||
    v.protocol === 'wmts'
  );
}

/**
 * Resolve which layers a `service` item curates. Mirrors
 * arcgis-service.ts pickedLayers(): when `selectedLayerIds` is set,
 * filter to those indices; otherwise return every probed layer for
 * backward compatibility with items written before the picker shipped.
 */
export function pickedServiceLayers(
  data: Pick<ServiceData, 'layers' | 'selectedLayerIds'>,
): ServiceLayerSnapshot[] {
  if (!data.selectedLayerIds || data.selectedLayerIds.length === 0) {
    return data.layers;
  }
  const out: ServiceLayerSnapshot[] = [];
  for (const i of data.selectedLayerIds) {
    const layer = data.layers[i];
    if (layer) out.push(layer);
  }
  return out;
}
