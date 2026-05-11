// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StyleSpecification } from 'maplibre-gl';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';

// Register the pmtiles:// protocol with MapLibre once per page
// load (#179). MapLibre's setStyle / addSource use the protocol
// transparently when a tile source's URL begins with pmtiles://,
// so basemaps backed by a tile_layer item get range-served
// straight from MinIO via the api's proxy endpoint with no
// other plumbing.
//
// We do this at module load (rather than per-map mount) because
// the protocol is global state on the maplibregl singleton; a
// per-mount register+remove pair would race when multiple maps
// share a page. The guard makes the module idempotent under HMR.
declare global {
  // eslint-disable-next-line no-var
  var __ggPmtilesRegistered: boolean | undefined;
}
if (typeof globalThis.__ggPmtilesRegistered === 'undefined') {
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  globalThis.__ggPmtilesRegistered = true;
}

/**
 * Shape of a custom basemap row coming back from /api/basemaps.
 * Mirrors the Prisma Basemap model; duplicated here to keep the
 * web package free of a @prisma/client build-time dep.
 */
export interface CustomBasemap {
  id: string;
  orgId: string;
  label: string;
  description: string;
  url: string;
  sourceKind: 'xyz' | 'vector-style' | 'wms';
  attribution: string;
  thumbnailUrl: string | null;
  config: Record<string, unknown> | null;
  isDefault: boolean;
}

// Same public glyph endpoint the built-in raster basemaps use. Swap
// for a self-hosted font pack in production deployments.
const DEFAULT_GLYPHS =
  'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf';

/**
 * Turn a custom basemap row into a MapLibre StyleSpecification that
 * can be passed to map.setStyle(). Three source kinds supported:
 *
 *   xyz          raster tile template with {z}/{x}/{y} placeholders
 *   vector-style a style.json URL we hand to MapLibre directly
 *   wms          raster over WMS GetMap; needs layers/format/CRS in
 *                the row's `config` JSON
 *
 * For `vector-style` we return a sentinel that the caller (MapCanvas)
 * handles specially: MapLibre's setStyle() accepts a URL string in
 * addition to a StyleSpecification, so we use the string form to let
 * it fetch and parse the JSON itself.
 */
export type CustomStyle =
  | { kind: 'inline'; style: StyleSpecification }
  | { kind: 'url'; url: string };

export function customBasemapToStyle(b: CustomBasemap): CustomStyle {
  if (b.sourceKind === 'vector-style') {
    return { kind: 'url', url: b.url };
  }

  if (b.sourceKind === 'xyz') {
    // #179: pmtiles:// URLs use a different source shape. The
    // pmtiles protocol returns a tile-JSON document when given
    // the source `url` (no {z}/{x}/{y} template substitution),
    // so we emit `url` instead of `tiles`. Both raster and
    // vector PMTiles caches can land here; the inner content
    // type is signalled by the cache file itself so we default
    // to raster (the common basemap case). Vector pmtiles
    // basemaps need their source-layer + style configured by
    // the author and are out of v1 scope here -- the user
    // would instead use a style.json (the 'vector-style' path).
    if (b.url.startsWith('pmtiles://')) {
      return {
        kind: 'inline',
        style: {
          version: 8,
          glyphs: DEFAULT_GLYPHS,
          sources: {
            raster: {
              type: 'raster',
              url: b.url,
              tileSize: 256,
              attribution: b.attribution || undefined,
            },
          },
          layers: [
            { id: 'raster-layer', type: 'raster', source: 'raster' },
          ],
        } as StyleSpecification,
      };
    }
    return {
      kind: 'inline',
      style: {
        version: 8,
        glyphs: DEFAULT_GLYPHS,
        sources: {
          raster: {
            type: 'raster',
            tiles: [b.url],
            tileSize: 256,
            attribution: b.attribution || undefined,
          },
        },
        layers: [{ id: 'raster-layer', type: 'raster', source: 'raster' }],
      } as StyleSpecification,
    };
  }

  // WMS: we treat the URL as the GetMap base and compose a tile URL
  // with the standard WMS 1.1.1 / 1.3.0 parameters. Callers populate
  // `config` with `layers` (required), plus optional `format`,
  // `transparent`, `version`, `styles`, `crs`.
  const cfg = (b.config ?? {}) as Record<string, unknown>;
  const layers = typeof cfg.layers === 'string' ? cfg.layers : '';
  const format = typeof cfg.format === 'string' ? cfg.format : 'image/png';
  const transparent =
    cfg.transparent === true || cfg.transparent === 'true' ? 'TRUE' : 'FALSE';
  const version = typeof cfg.version === 'string' ? cfg.version : '1.3.0';
  const styles = typeof cfg.styles === 'string' ? cfg.styles : '';
  const crs = typeof cfg.crs === 'string' ? cfg.crs : 'EPSG:3857';
  const bboxParam = version.startsWith('1.3')
    ? '{bbox-epsg-3857}'
    : '{bbox-epsg-3857}';
  const tileUrl = buildWmsTileUrl(b.url, {
    SERVICE: 'WMS',
    VERSION: version,
    REQUEST: 'GetMap',
    LAYERS: layers,
    STYLES: styles,
    FORMAT: format,
    TRANSPARENT: transparent,
    [version.startsWith('1.3') ? 'CRS' : 'SRS']: crs,
    WIDTH: '256',
    HEIGHT: '256',
    BBOX: bboxParam,
  });

  return {
    kind: 'inline',
    style: {
      version: 8,
      glyphs: DEFAULT_GLYPHS,
      sources: {
        raster: {
          type: 'raster',
          tiles: [tileUrl],
          tileSize: 256,
          attribution: b.attribution || undefined,
        },
      },
      layers: [{ id: 'raster-layer', type: 'raster', source: 'raster' }],
    } as StyleSpecification,
  };
}

/**
 * Preserve any query string already on the WMS base URL and append
 * the standard parameters. WMS servers are historically picky about
 * case; upper-case keys are the safe common denominator.
 */
function buildWmsTileUrl(
  base: string,
  params: Record<string, string>,
): string {
  const hasQuery = base.includes('?');
  const separator = hasQuery ? '&' : '?';
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeWmsParam(v)}`)
    .join('&');
  return `${base}${separator}${qs}`;
}

/**
 * MapLibre's bbox placeholder already includes braces, so we should
 * NOT url-encode it: encoding would break the substitution. Every
 * other value is safe to encodeURIComponent.
 */
function encodeWmsParam(v: string): string {
  if (v.startsWith('{bbox-')) return v;
  return encodeURIComponent(v);
}
