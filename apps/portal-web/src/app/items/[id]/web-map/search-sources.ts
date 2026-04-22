/**
 * Two shaped-identically search sources powering the map's search bar:
 *
 *   1. Attribute search over each layer's cached FeatureCollection.
 *      Walks features looking for substring matches against whichever
 *      fields the layer owner marked as searchable. Fast; works
 *      entirely client-side.
 *
 *   2. Geocoding via Nominatim (https://nominatim.openstreetmap.org/).
 *      Free, no API key, rate-limited to 1 req/sec per their policy —
 *      so we debounce in the UI. We send a descriptive User-Agent as
 *      required, credit OSM in the results footer, and do NOT cache
 *      beyond the single session.
 */

import type { WebMapLayer } from '@gratis-gis/shared-types';

export type SearchResult =
  | {
      kind: 'feature';
      layerId: string;
      layerTitle: string;
      label: string;
      subtitle: string | null;
      /** Preferred: a bounding box of the hit feature. */
      bbox: [number, number, number, number] | null;
      /** Fallback for a bare-point hit: a center coordinate + default zoom. */
      center: [number, number] | null;
      /**
       * The full GeoJSON feature so the canvas can highlight it by
       * matching against the source data. Kept on the result because a
       * layer may contain thousands of features and we don't want to
       * look it up by id again.
       */
      feature: GeoJSON.Feature;
    }
  | {
      kind: 'place';
      label: string;
      subtitle: string | null;
      bbox: [number, number, number, number] | null;
      center: [number, number] | null;
    };

const MAX_ATTRIBUTE_HITS_PER_LAYER = 8;
/**
 * Client talks to our own proxy, not Nominatim directly. The proxy
 * (apps/portal-web/src/app/api/geocode/route.ts) forwards to whatever
 * NOMINATIM_URL is configured for the deployment — local docker
 * container for self-hosted, a regional cluster in prod, or the
 * public OSM endpoint for demos. Doing it this way keeps one env var
 * as the swap point, lets us set the required User-Agent from Node,
 * and leaves an obvious spot to add caching / rate limits.
 */
const GEOCODE_URL = '/api/geocode';

/**
 * Rank layer features by how well they match `query`. Each result
 * carries the layer it came from so the UI can group/prefix.
 */
export function searchLayers(
  query: string,
  layers: WebMapLayer[],
  featuresByLayer: Record<string, GeoJSON.FeatureCollection | null>,
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: SearchResult[] = [];

  for (const layer of layers) {
    if (!layer.search?.enabled) continue;
    const fields = layer.search.fields.filter((f) => f.length > 0);
    if (fields.length === 0) continue;
    const fc = featuresByLayer[layer.id];
    if (!fc) continue;

    let layerHits = 0;
    for (const f of fc.features) {
      if (layerHits >= MAX_ATTRIBUTE_HITS_PER_LAYER) break;
      const props = (f.properties ?? {}) as Record<string, unknown>;
      let matched = false;
      for (const field of fields) {
        const v = props[field];
        if (v === null || v === undefined) continue;
        if (String(v).toLowerCase().includes(q)) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;

      const label = layer.search.labelTemplate
        ? renderTemplate(layer.search.labelTemplate, props)
        : firstNonEmpty(fields.map((ff) => props[ff])) ?? '(unnamed)';
      out.push({
        kind: 'feature',
        layerId: layer.id,
        layerTitle: layer.title,
        label,
        subtitle: fields
          .map((ff) => {
            const val = props[ff];
            return val ? `${ff}: ${val}` : null;
          })
          .filter(Boolean)
          .join(' · ') || null,
        bbox: featureBbox(f),
        center: featureCenter(f),
        feature: f,
      });
      layerHits += 1;
    }
  }
  return out;
}

/**
 * Ask Nominatim for matches. The abort signal cancels stale requests
 * so the UI never applies a result that's already been superseded.
 */
export async function geocode(
  query: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const url = `${GEOCODE_URL}?q=${encodeURIComponent(q)}`;
  const init: RequestInit = { headers: { Accept: 'application/json' } };
  if (signal) init.signal = signal;

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return [];
    return [];
  }
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<{
    display_name: string;
    lat: string;
    lon: string;
    boundingbox?: [string, string, string, string];
    type?: string;
    class?: string;
  }>;
  return rows.map((row) => {
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    const bb = row.boundingbox;
    const bbox =
      bb && bb.length === 4
        ? ([Number(bb[2]), Number(bb[0]), Number(bb[3]), Number(bb[1])] as [
            number,
            number,
            number,
            number,
          ])
        : null;
    return {
      kind: 'place' as const,
      label: row.display_name,
      subtitle: row.class
        ? `${row.class}${row.type ? ` · ${row.type}` : ''}`
        : null,
      bbox,
      center: Number.isFinite(lat) && Number.isFinite(lon) ? [lon, lat] : null,
    };
  });
}

function featureBbox(
  f: GeoJSON.Feature,
): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;
  function visit(v: unknown) {
    if (Array.isArray(v)) {
      if (v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
        const x = v[0] as number;
        const y = v[1] as number;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        seen = true;
      } else {
        for (const c of v) visit(c);
      }
    }
  }
  const geom = f.geometry;
  if (!geom) return null;
  if ('coordinates' in geom) visit(geom.coordinates);
  else if (geom.type === 'GeometryCollection') {
    for (const g of geom.geometries) {
      if ('coordinates' in g) visit(g.coordinates);
    }
  }
  return seen ? [minX, minY, maxX, maxY] : null;
}

function featureCenter(f: GeoJSON.Feature): [number, number] | null {
  const geom = f.geometry;
  if (!geom) return null;
  if (geom.type === 'Point') {
    const c = geom.coordinates as number[];
    return c.length >= 2 ? [c[0]!, c[1]!] : null;
  }
  const bb = featureBbox(f);
  if (!bb) return null;
  return [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
}

function firstNonEmpty(vs: unknown[]): string | null {
  for (const v of vs) {
    if (v !== null && v !== undefined && String(v).length > 0) return String(v);
  }
  return null;
}

function renderTemplate(
  template: string,
  props: Record<string, unknown>,
): string {
  return template.replace(
    /\{\{\s*([\w.-]+)\s*(?:\|\s*([\w.-]+))?\s*\}\}/g,
    (_, key: string, formatter?: string) => {
      const raw = props[key];
      if (raw === undefined || raw === null) return '';
      const str = String(raw);
      switch (formatter?.toLowerCase()) {
        case 'upper':
          return str.toUpperCase();
        case 'lower':
          return str.toLowerCase();
        case 'number': {
          const n = Number(str);
          return Number.isNaN(n) ? str : n.toLocaleString();
        }
        default:
          return str;
      }
    },
  );
}
