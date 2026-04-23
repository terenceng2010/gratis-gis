import type { ItemType } from '@prisma/client';

/**
 * Walks an item's data payload and returns the ids of any other items
 * it references. Returns a *flat* list of item ids — the caller can
 * look up types, titles, etc. against the main item table.
 *
 * Adding a new item type's extraction rule? Add a branch below and add
 * the new type to the REFERENCER_TYPES array used by the service so
 * the dependents scan knows to consider items of that type.
 *
 * Today's coverage:
 *   - web_map.data.layers[].itemId
 *       references feature_service or arcgis_service items
 *
 * Future candidates (tasks exist for each):
 *   - dashboard.data.panels[].itemId        (dashboards reference web maps / feature services)
 *   - form.data.targetItemId                (form submissions write into a feature service)
 *   - report_template.data.sources[].itemId (report data sources)
 *   - web_app.data.mapItemId                (web apps embed a web map)
 */
export function extractDependencies(
  item: { type: ItemType; data: unknown },
): string[] {
  const data = item.data as Record<string, unknown> | null;
  if (!data) return [];

  const ids = new Set<string>();

  if (item.type === 'web_map') {
    const layers = Array.isArray((data as { layers?: unknown }).layers)
      ? ((data as { layers: unknown[] }).layers as Array<Record<string, unknown>>)
      : [];
    for (const l of layers) {
      const id = l?.itemId;
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    }
  }

  // Hook points for other types — extend as those item types come online.

  return Array.from(ids);
}

/** Item types that can reference other items. If we expand this,
 *  update the service's dependents scan to include the new types. */
export const REFERENCER_TYPES: ItemType[] = ['web_map'];
