import type { ItemType } from '@prisma/client';

/**
 * Walks an item's data payload and returns the references it holds to
 * other items. Two kinds of reference exist:
 *
 *   - `itemIds`: direct UUID references (feature-service layers).
 *   - `urls`:    URL references the caller can match against other
 *                items with structured URL data (today: arcgis_service
 *                items whose `data.url` matches).
 *
 * Keeping these separate lets the service build two reverse indexes
 * and match each kind of reference without a schema-wide JSON scan.
 *
 * Today's coverage for web_map layers (shared-types WebMapLayerSource):
 *   - source.kind === 'feature-service'  -> itemIds += source.itemId
 *   - source.kind === 'arcgis-rest'      -> urls    += source.url
 *   - source.kind === 'geojson-url'      -> (not tracked; external URL)
 *   - source.kind === 'geojson-inline'   -> (not tracked; inline data)
 *
 * Future candidates as those item types ship:
 *   - dashboard.data.panels[].itemId
 *   - form.data.targetItemId
 *   - report_template.data.sources[].itemId
 *   - web_app.data.mapItemId
 */
export interface Dependencies {
  itemIds: string[];
  urls: string[];
}

export function extractDependencies(
  item: { type: ItemType; data: unknown },
): Dependencies {
  const data = item.data as Record<string, unknown> | null;
  const itemIds = new Set<string>();
  const urls = new Set<string>();
  if (!data) return { itemIds: [], urls: [] };

  if (item.type === 'web_map') {
    const layers = Array.isArray((data as { layers?: unknown }).layers)
      ? ((data as { layers: unknown[] }).layers as Array<Record<string, unknown>>)
      : [];
    for (const l of layers) {
      const source = l?.source as Record<string, unknown> | undefined;
      if (!source || typeof source !== 'object') continue;
      const kind = source.kind;
      if (kind === 'feature-service') {
        const id = source.itemId;
        if (typeof id === 'string' && id.length > 0) itemIds.add(id);
      } else if (kind === 'arcgis-rest') {
        // Normalize the URL so we match regardless of whether the
        // caller's arcgis_service item stored the URL with or without
        // a trailing slash / trailing layer index.
        const raw = source.url;
        if (typeof raw === 'string' && raw.length > 0) {
          urls.add(normalizeArcgisUrl(raw));
        }
      }
    }
  }

  // Hook points for other types — extend as those item types come online.

  return { itemIds: Array.from(itemIds), urls: Array.from(urls) };
}

/**
 * Trailing-slash / trailing-`/0` tolerant URL key used to match
 * arcgis-rest layer URLs against arcgis_service item URLs.
 */
export function normalizeArcgisUrl(u: string): string {
  let s = u.trim().replace(/\/$/, '');
  // Strip a trailing /<layerId> segment so a layer URL (.../MapServer/2)
  // matches the service root (.../MapServer) the arcgis_service item
  // persists.
  s = s.replace(/\/(?:MapServer|FeatureServer)\/\d+$/i, (match) =>
    match.replace(/\/\d+$/, ''),
  );
  return s.toLowerCase();
}

/** Item types that can reference other items. If we expand this,
 *  update the service's dependents scan to include the new types. */
export const REFERENCER_TYPES: ItemType[] = ['web_map'];
