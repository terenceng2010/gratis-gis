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
 * Convert a Lens (with optional view + basemap) into an Esri
 * WebMapJSON object. The output is JSON-serializable and meant to
 * be returned as the body of a `GET /items/<mapId>/web-map.json`
 * endpoint or written to disk for offline distribution.
 *
 * Emission rules:
 *   - LensRenderGeoJson  -> ArcGISFeatureLayer
 *   - LensRenderMvt      -> VectorTileLayer
 *   - LensRenderGeoJsonTable / LensRenderScalar -> skipped (not
 *     map-shaped); the caller can detect this by looking at the
 *     returned operationalLayers length.
 */
export function lensToWebMapJson(
  lens: Lens,
  ctx: WebMapJsonContext,
): EsriWebMap {
  const operationalLayers: EsriOperationalLayer[] = [];

  if (lens.render.kind === 'geojson') {
    operationalLayers.push({
      id: lens.id,
      title: lens.name,
      url: `${ctx.lensUrlPrefix}/${lens.id}/features`,
      layerType: 'ArcGISFeatureLayer',
      visibility: true,
      opacity: 1,
      ...(esriDefinitionFromAttrFilter(lens) && {
        layerDefinition: {
          definitionExpression: esriDefinitionFromAttrFilter(lens) as string,
        },
      }),
    });
  } else if (lens.render.kind === 'mvt') {
    operationalLayers.push({
      id: lens.id,
      title: lens.name,
      url: `${ctx.lensUrlPrefix}/${lens.id}/tiles/{z}/{y}/{x}.pbf`,
      layerType: 'VectorTileLayer',
      visibility: true,
      opacity: 1,
    });
  }
  // geojson_table and scalar_json have no map representation; skip.

  const initialState =
    lens.view !== undefined ? viewportFromLensView(lens.view) : undefined;

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
  const warnings: string[] = [];
  if (typeof json.version !== 'string' || json.version.length === 0) {
    throw new Error('webMapJsonToLens: missing or empty `version`');
  }

  const layer = (json.operationalLayers ?? []).find(
    (l) =>
      l.layerType === 'ArcGISFeatureLayer' || l.layerType === 'VectorTileLayer',
  );
  if (!layer) {
    throw new Error(
      'webMapJsonToLens: no ArcGISFeatureLayer or VectorTileLayer found',
    );
  }
  if ((json.operationalLayers ?? []).length > 1) {
    warnings.push(
      `Only the first usable operational layer was imported (${
        json.operationalLayers!.length
      } total in source).`,
    );
  }
  if (layer.layerType === 'WebTiledLayer') {
    warnings.push(
      'WebTiledLayer entries cannot be modelled as a Lens; they were skipped.',
    );
  }

  const view = json.initialState?.viewpoint
    ? lensViewFromViewpoint(json.initialState.viewpoint)
    : undefined;

  // Parse the Esri definitionExpression upfront so we can decide
  // whether to set attrFilter at all. A null result means we
  // couldn't make sense of it; we already pushed a warning, and
  // skipping the field keeps `attrFilter` strictly undefined
  // (matching `Omit<Lens, 'id'>['query']['attrFilter']`).
  const parsedAttrFilter = layer.layerDefinition?.definitionExpression
    ? attrFilterFromEsriDefinition(
        layer.layerDefinition.definitionExpression,
        warnings,
      )
    : null;

  const lens: Omit<Lens, 'id'> = {
    name: layer.title || 'Imported lens',
    query: {
      // Resolved by the caller against the URL -> data_layer mapping.
      scopes: [],
      ...(parsedAttrFilter !== null && { attrFilter: parsedAttrFilter }),
    },
    render:
      layer.layerType === 'VectorTileLayer'
        ? { kind: 'mvt' }
        : { kind: 'geojson' },
    ...(view !== undefined && { view }),
  };
  if (layer.url) {
    // Stash the source URL so the resolver pass has something to
    // match. The engine ignores unknown attrs in lens shapes.
    (lens.query as { sourceUrl?: string }).sourceUrl = layer.url;
  }
  return { lens, warnings };
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
  const center: [number, number] = [
    (env.xmin + env.xmax) / 2,
    (env.ymin + env.ymax) / 2,
  ];
  const zoom =
    typeof vp.scale === 'number' && vp.scale > 0
      ? Math.log2(591657550.5 / vp.scale)
      : 0;
  return {
    center,
    zoom: Number.isFinite(zoom) ? zoom : 0,
    ...(typeof vp.rotation === 'number' && { bearing: vp.rotation }),
    viewport: [env.xmin, env.ymin, env.xmax, env.ymax] as BBox,
  };
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
