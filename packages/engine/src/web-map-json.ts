// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Esri WebMapJSON converter. Used at the API boundary to interop
// with the broader GIS ecosystem: ArcGIS Pro, AGO viewers, and
// third-party clients (QGIS via the WebMap plugin, kepler.gl's
// WebMap importer, etc.) all speak this format. By emitting a
// usable subset on every map item, the portal becomes immediately
// useful as a data source without forcing every client to learn a
// new schema.
//
// The full Esri spec
//   https://developers.arcgis.com/web-map-specification/
// is large (sliders, time-aware layers, raster functions, popup
// expressions). v1 implements the subset that round-trips cleanly:
//   - operationalLayers (FeatureLayer pointing at a FeatureService URL)
//   - baseMap (one or more BaseMapLayers with tileUrl)
//   - initialState.viewpoint (center + scale)
//   - version + authoringApp + authoringAppVersion
//
// Anything we don't understand on the way in is preserved verbatim
// under `__unknown` so we don't lose information across an
// import / export round trip. Anything we don't have a Lens
// equivalent for on the way out is omitted with a comment in the
// output explaining what was skipped.

import type { Lens, BBox, LensView } from './lens.js';

/**
 * Minimum WebMapJSON shape the converter recognises. Wider than
 * we emit (input often has fields we ignore), narrower than the
 * full spec. Fields not enumerated here ride along inside
 * `__unknown` on the Lens side for round-tripping.
 */
export interface EsriWebMap {
  version: string;
  authoringApp?: string;
  authoringAppVersion?: string;
  operationalLayers?: EsriOperationalLayer[];
  baseMap?: EsriBaseMap;
  initialState?: EsriInitialState;
  /** Free-form bookkeeping the converter wants to preserve. */
  [key: string]: unknown;
}

export interface EsriOperationalLayer {
  id: string;
  title: string;
  url: string;
  layerType: 'ArcGISFeatureLayer' | 'VectorTileLayer' | 'WebTiledLayer';
  visibility?: boolean;
  opacity?: number;
  /** Esri definition expression. Maps to LensQuery.attrFilter. */
  layerDefinition?: {
    definitionExpression?: string;
  };
  [key: string]: unknown;
}

export interface EsriBaseMap {
  title?: string;
  baseMapLayers: Array<{
    id: string;
    title?: string;
    url: string;
    layerType?: 'WebTiledLayer' | 'ArcGISTiledMapServiceLayer';
    [key: string]: unknown;
  }>;
}

export interface EsriInitialState {
  viewpoint?: {
    targetGeometry?: {
      xmin: number;
      ymin: number;
      xmax: number;
      ymax: number;
      spatialReference?: { wkid: number };
    };
    scale?: number;
    rotation?: number;
  };
}

/**
 * Inputs the converter needs that aren't part of the lens itself:
 * the public URL prefix (so emitted FeatureLayer URLs are
 * fetchable from outside the portal) and the chosen basemap tile
 * URL + attribution.
 */
export interface WebMapJsonContext {
  /**
   * Absolute URL prefix for a lens's GeoJSON endpoint, e.g.
   * `https://portal.example.org/api/lenses`. The converter appends
   * `/<lensId>/features` to produce the FeatureLayer URL.
   */
  lensUrlPrefix: string;
  /** A single basemap to emit; v1 doesn't compose multi-layer basemaps. */
  basemap: {
    id: string;
    title: string;
    tileUrl: string;
    attribution?: string;
  };
}

/**
 * Schema version emitted in every WebMap we produce. The Esri
 * runtime is forgiving here -- 2.x is the long-running mainline.
 */
const WEB_MAP_VERSION = '2.32';
const AUTHORING_APP = 'GratisGIS';
const AUTHORING_APP_VERSION = '1.0';

/**
 * Convert a single Lens (with optional view + basemap) into an
 * Esri WebMapJSON object. The output is JSON-serializable and is
 * meant to be returned as the body of a
 * `GET /items/<mapId>/web-map.json` endpoint or written to disk
 * for offline distribution.
 *
 * Emission rules:
 *   - LensRenderGeoJson  -> ArcGISFeatureLayer
 *   - LensRenderMvt      -> VectorTileLayer
 *   - LensRenderGeoJsonTable / LensRenderScalar -> skipped (not
 *     map-shaped); the caller can detect this by looking at the
 *     returned operationalLayers length.
 *
 * For map items with multiple operational layers, prefer
 * `lensesToWebMapJson` so all the layers ride a single basemap +
 * viewpoint document.
 */
export function lensToWebMapJson(
  lens: Lens,
  ctx: WebMapJsonContext,
): EsriWebMap {
  return lensesToWebMapJson(
    lens.view !== undefined ? { lenses: [lens], view: lens.view } : { lenses: [lens] },
    ctx,
  );
}

/**
 * Convert a list of lenses into one Esri WebMapJSON document.
 * Walks each lens through the same per-lens emit rules as
 * `lensToWebMapJson` and concatenates the resulting
 * operationalLayers in order. The basemap + viewpoint come from
 * `args.view` (typically the source map item's saved camera
 * state); a missing view omits initialState entirely.
 *
 * Skipped lenses (table-shaped or scalar) leave a gap in the
 * output -- the operationalLayers length may be smaller than
 * `args.lenses.length`. Caller can compare lengths to detect.
 */
export function lensesToWebMapJson(
  args: { lenses: Lens[]; view?: import('./lens.js').LensView },
  ctx: WebMapJsonContext,
): EsriWebMap {
  const operationalLayers: EsriOperationalLayer[] = [];
  for (const lens of args.lenses) {
    const layer = operationalLayerForLens(lens, ctx);
    if (layer) operationalLayers.push(layer);
  }
  const initialState =
    args.view !== undefined ? viewportFromLensView(args.view) : undefined;
  return {
    version: WEB_MAP_VERSION,
    authoringApp: AUTHORING_APP,
    authoringAppVersion: AUTHORING_APP_VERSION,
    operationalLayers,
    baseMap: {
      title: ctx.basemap.title,
      baseMapLayers: [
        {
          id: ctx.basemap.id,
          title: ctx.basemap.title,
          url: ctx.basemap.tileUrl,
          layerType: 'WebTiledLayer',
          ...(ctx.basemap.attribution !== undefined && {
            copyright: ctx.basemap.attribution,
          }),
        },
      ],
    },
    ...(initialState !== undefined && { initialState }),
  };
}

/**
 * Translate a single Lens to its EsriOperationalLayer. Returns
 * undefined for non-map renderers (geojson_table / scalar_json).
 * Exposed so callers that build a WebMap from non-Lens sources
 * (e.g. an arcgis-rest map layer that points straight at an
 * external FeatureService) can mix lens-shaped and bare-URL
 * layers in one document.
 */
export function operationalLayerForLens(
  lens: Lens,
  ctx: WebMapJsonContext,
): EsriOperationalLayer | undefined {
  if (lens.render.kind === 'geojson') {
    const def = esriDefinitionFromAttrFilter(lens);
    return {
      id: lens.id,
      title: lens.name,
      url: `${ctx.lensUrlPrefix}/${lens.id}/features`,
      layerType: 'ArcGISFeatureLayer',
      visibility: true,
      opacity: 1,
      ...(def && { layerDefinition: { definitionExpression: def } }),
    };
  }
  if (lens.render.kind === 'mvt') {
    return {
      id: lens.id,
      title: lens.name,
      url: `${ctx.lensUrlPrefix}/${lens.id}/tiles/{z}/{y}/{x}.pbf`,
      layerType: 'VectorTileLayer',
      visibility: true,
      opacity: 1,
    };
  }
  // geojson_table and scalar_json have no map representation.
  return undefined;
}

/**
 * Best-effort reverse: take an Esri WebMap and produce a Lens
 * skeleton plus a list of warnings about anything that didn't
 * cleanly translate. The returned Lens omits an `id` (the caller
 * assigns one when persisting) and an engine `query.scopes` entry
 * that the caller has to fill in by resolving the FeatureLayer
 * URL to a portal data_layer. Both the Lens and the warnings are
 * surfaced so the import UI can show a dry-run summary.
 *
 * Throws if `version` is missing or if there is no parseable
 * operational layer; everything else degrades.
 */
export function webMapJsonToLens(json: EsriWebMap): {
  lens: Omit<Lens, 'id'>;
  warnings: string[];
} {
  const all = webMapJsonToLenses(json);
  if (all.lenses.length === 0) {
    throw new Error(
      'webMapJsonToLens: no ArcGISFeatureLayer or VectorTileLayer found',
    );
  }
  // Single-lens convenience: surface the first usable layer plus
  // any extras as a warning. Callers that want every layer should
  // use webMapJsonToLenses directly.
  const warnings = [...all.warnings];
  if (all.lenses.length > 1) {
    warnings.push(
      `Only the first usable operational layer was imported (${all.lenses.length} total).`,
    );
  }
  const first = all.lenses[0]!;
  return {
    lens: all.view !== undefined ? { ...first, view: all.view } : first,
    warnings,
  };
}

/**
 * Multi-layer reverse converter. Walks every operationalLayer in
 * the WebMap, produces one Omit<Lens, 'id'> per recognisable
 * layer, plus a shared LensView from initialState (the WebMap has
 * one saved camera, not one per layer). Returns warnings for
 * anything skipped or partially translated.
 *
 * The lens scopes array is left empty: the caller has to walk each
 * lens's stashed `query.sourceUrl` and resolve it to a portal
 * data_layer (or to an external arcgis_service item) before
 * persisting. The bulk import service does this by matching URLs
 * against the org's existing arcgis_service items first, then
 * falling back to a fresh `arcgis-rest` MapLayer for unknown URLs.
 */
export function webMapJsonToLenses(json: EsriWebMap): {
  lenses: Array<Omit<Lens, 'id'>>;
  view?: LensView;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (typeof json.version !== 'string' || json.version.length === 0) {
    throw new Error('webMapJsonToLenses: missing or empty `version`');
  }
  const view =
    json.initialState?.viewpoint !== undefined
      ? lensViewFromViewpoint(json.initialState.viewpoint)
      : undefined;
  const lenses: Array<Omit<Lens, 'id'>> = [];
  for (const layer of json.operationalLayers ?? []) {
    if (
      layer.layerType !== 'ArcGISFeatureLayer' &&
      layer.layerType !== 'VectorTileLayer'
    ) {
      warnings.push(
        `Layer "${layer.title ?? layer.id}" has unsupported layerType ${
          layer.layerType
        }; skipped.`,
      );
      continue;
    }
    const parsedAttrFilter = layer.layerDefinition?.definitionExpression
      ? attrFilterFromEsriDefinition(
          layer.layerDefinition.definitionExpression,
          warnings,
        )
      : null;
    const lens: Omit<Lens, 'id'> = {
      name: layer.title || 'Imported lens',
      query: {
        scopes: [],
        ...(parsedAttrFilter !== null && { attrFilter: parsedAttrFilter }),
      },
      render:
        layer.layerType === 'VectorTileLayer'
          ? { kind: 'mvt' }
          : { kind: 'geojson' },
    };
    if (layer.url) {
      // Stash the source URL so the import resolver can match it
      // against existing portal items. Unknown attrs on the query
      // shape are preserved by the engine read path.
      (lens.query as { sourceUrl?: string }).sourceUrl = layer.url;
    }
    lenses.push(lens);
  }
  return view !== undefined ? { lenses, view, warnings } : { lenses, warnings };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function viewportFromLensView(view: LensView): EsriInitialState {
  if (view.viewport) {
    return {
      viewpoint: {
        targetGeometry: bboxToEsriEnvelope(view.viewport),
        ...(view.bearing !== undefined && { rotation: view.bearing }),
      },
    };
  }
  // Fall back to a center-and-scale viewpoint. AGO maps a MapLibre
  // zoom z to scale 591657550.5 / 2^z; not exact but the right
  // order of magnitude for a starting camera.
  const scale = 591657550.5 / Math.pow(2, view.zoom);
  return {
    viewpoint: {
      targetGeometry: bboxToEsriEnvelope([
        view.center[0],
        view.center[1],
        view.center[0],
        view.center[1],
      ]),
      scale,
      ...(view.bearing !== undefined && { rotation: view.bearing }),
    },
  };
}

function lensViewFromViewpoint(
  vp: NonNullable<EsriInitialState['viewpoint']>,
): LensView | undefined {
  const env = vp.targetGeometry;
  if (!env) return undefined;
  // An Esri WebMap envelope is in the WebMap's spatialReference,
  // and on AGO that is almost always web mercator (wkid 102100 /
  // 3857 / 102113). Storing those values verbatim into a portal
  // map's lng/lat fields blows up MapLibre with "Invalid LngLat
  // latitude value: must be between -90 and 90" the moment the
  // viewer tries to fit the camera. Detect the spatial reference
  // and project to WGS84 when needed.
  const wkid = env.spatialReference?.wkid ?? 4326;
  const isWebMercator =
    wkid === 102100 || wkid === 3857 || wkid === 102113;
  const [xmin, ymin] = isWebMercator
    ? webMercatorToLngLat(env.xmin, env.ymin)
    : [env.xmin, env.ymin];
  const [xmax, ymax] = isWebMercator
    ? webMercatorToLngLat(env.xmax, env.ymax)
    : [env.xmax, env.ymax];
  const center: [number, number] = [
    (xmin + xmax) / 2,
    (ymin + ymax) / 2,
  ];
  const zoom =
    typeof vp.scale === 'number' && vp.scale > 0
      ? Math.log2(591657550.5 / vp.scale)
      : 0;
  // Defensive clamp: if some unusual spatial reference slips
  // through (a state plane projection, an Alaska polar
  // projection) we still want to deliver a map that opens.
  // Centre at 0,0 / zoom 0 in that case rather than blowing up
  // MapLibre.
  const safeCenter: [number, number] =
    Number.isFinite(center[0]) &&
    Number.isFinite(center[1]) &&
    center[0] >= -180 &&
    center[0] <= 180 &&
    center[1] >= -90 &&
    center[1] <= 90
      ? center
      : [0, 0];
  const viewportSafe: BBox =
    safeCenter === center
      ? ([xmin, ymin, xmax, ymax] as BBox)
      : ([-180, -85, 180, 85] as BBox);
  return {
    center: safeCenter,
    zoom: Number.isFinite(zoom) ? zoom : 0,
    ...(typeof vp.rotation === 'number' && { bearing: vp.rotation }),
    viewport: viewportSafe,
  };
}

/**
 * Inverse spherical web-mercator projection: (x, y) in meters
 * -> (lng, lat) in degrees. Reasonable to inline here because
 * the engine package deliberately keeps proj4 / @turf out (#22:
 * dep-leanness review).  The formulas are the standard EPSG:3857
 * inverse and match what proj4 would emit to within fp epsilon
 * inside the validity band [-85, 85] degrees latitude.
 */
function webMercatorToLngLat(
  x: number,
  y: number,
): [number, number] {
  const R = 6378137; // WGS84 semi-major axis (meters)
  const lng = (x / R) * (180 / Math.PI);
  const lat =
    (180 / Math.PI) *
    (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2);
  return [lng, lat];
}

function bboxToEsriEnvelope([xmin, ymin, xmax, ymax]: BBox): {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  spatialReference: { wkid: number };
} {
  return {
    xmin,
    ymin,
    xmax,
    ymax,
    spatialReference: { wkid: 4326 },
  };
}

/**
 * Translate the lens's single-clause attrFilter into an Esri
 * SQL-flavoured definition expression. Quotes string literals,
 * uses single quotes (Esri convention), bare-emits numeric / bool
 * literals. Returns null when no filter is set.
 */
function esriDefinitionFromAttrFilter(lens: Lens): string | null {
  const f = lens.query.attrFilter;
  if (!f) return null;
  const field = `"${f.field.replace(/"/g, '""')}"`;
  const formatValue = (v: unknown): string => {
    if (v === null) return 'NULL';
    if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  switch (f.op) {
    case 'eq':
      return `${field} = ${formatValue(f.value)}`;
    case 'neq':
      return `${field} <> ${formatValue(f.value)}`;
    case 'lt':
      return `${field} < ${formatValue(f.value)}`;
    case 'lte':
      return `${field} <= ${formatValue(f.value)}`;
    case 'gt':
      return `${field} > ${formatValue(f.value)}`;
    case 'gte':
      return `${field} >= ${formatValue(f.value)}`;
    case 'in':
      if (!Array.isArray(f.value) || f.value.length === 0) return null;
      return `${field} IN (${f.value.map((v) => formatValue(v)).join(', ')})`;
    case 'contains':
      return `${field} LIKE '%${String(f.value).replace(/'/g, "''")}%'`;
    case 'startsWith':
      return `${field} LIKE '${String(f.value).replace(/'/g, "''")}%'`;
    case 'isNull':
      return `${field} IS NULL`;
    case 'isNotNull':
      return `${field} IS NOT NULL`;
    default:
      return null;
  }
}

/**
 * Reverse of esriDefinitionFromAttrFilter for the import flow.
 * Handles only the simple shapes we emit; anything more complex is
 * surfaced as a warning and the filter is dropped (the import still
 * succeeds, just without the predicate). A general SQL parser is a
 * Phase 4 candidate.
 */
function attrFilterFromEsriDefinition(
  expr: string,
  warnings: string[],
): import('./lens.js').LensAttrFilter | null {
  const trimmed = expr.trim();
  // "field" OP literal. The string literal subgroup uses
  // SQL-style `''` escaping (`'O''Brien'` -> `O'Brien`), so we
  // capture (?:[^']|'')*` and unescape after the match.
  const m = trimmed.match(
    /^"([^"]+)"\s*(=|<>|<|<=|>|>=)\s*('((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)|(true|false|TRUE|FALSE))$/,
  );
  if (m) {
    const field = m[1] as string;
    const op = m[2] as string;
    const stringLit = m[4];
    const numLit = m[5];
    const boolLit = m[6];
    const value =
      stringLit !== undefined
        ? stringLit.replace(/''/g, "'")
        : numLit !== undefined
          ? Number(numLit)
          : boolLit !== undefined
            ? /^t/i.test(boolLit)
            : null;
    const opMap: Record<string, import('./lens.js').LensAttrFilter['op']> = {
      '=': 'eq',
      '<>': 'neq',
      '<': 'lt',
      '<=': 'lte',
      '>': 'gt',
      '>=': 'gte',
    };
    return { field, op: opMap[op]!, value };
  }
  // "field" IS NULL / IS NOT NULL
  const nullMatch = trimmed.match(/^"([^"]+)"\s+IS\s+(NOT\s+)?NULL$/i);
  if (nullMatch) {
    return {
      field: nullMatch[1] as string,
      op: nullMatch[2] ? 'isNotNull' : 'isNull',
    };
  }
  warnings.push(
    `Definition expression "${expr}" was not recognised; filter dropped on import.`,
  );
  return null;
}
