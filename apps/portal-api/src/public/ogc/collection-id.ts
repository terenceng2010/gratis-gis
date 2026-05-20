// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Collection-id parser for the OGC API surface. See
 * `docs/ogc-api-strategy.md` for the contract.
 *
 * Three shapes are accepted:
 *
 *   - `<itemId>`                          - bare UUID; refers to the
 *                                           first layer in the
 *                                           data_layer item. Kept
 *                                           for back-compat with
 *                                           the v1 single-layer
 *                                           contract.
 *   - `<itemId>__<layerKey>`              - explicit per-layer
 *                                           collection. The
 *                                           preferred new form.
 *   - anything else                       - null (404 at the
 *                                           caller).
 *
 * `__` was chosen as the separator because UUIDs are `[0-9a-f-]`
 * only so the double underscore can't collide, and v3 layer keys
 * are validated to forbid the substring `__` (see
 * `feature-service.ts` v3 layer key validator).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LAYER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface ParsedCollectionId {
  /** Item UUID (the `data_layer` item). */
  itemId: string;
  /**
   * Explicit layer key when the collection id used the
   * `<itemId>__<layerKey>` form; null when the caller passed a bare
   * UUID and the resolver should fall back to the first layer.
   */
  layerKey: string | null;
}

export function parseCollectionId(id: string): ParsedCollectionId | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  // Look for the explicit layer-key suffix first; if the input
  // contains `__`, the segment before must be a UUID and the segment
  // after must match the layer-key shape. Anything else is invalid
  // (we don't fall through to "bare uuid" because a malformed
  // suffixed id should 404, not silently downgrade to the first
  // layer of a UUID prefix).
  const sep = id.indexOf('__');
  if (sep >= 0) {
    const itemId = id.slice(0, sep);
    const layerKey = id.slice(sep + 2);
    if (!UUID_RE.test(itemId)) return null;
    if (!LAYER_KEY_RE.test(layerKey)) return null;
    return { itemId, layerKey };
  }
  if (!UUID_RE.test(id)) return null;
  return { itemId: id, layerKey: null };
}

/**
 * Encode a collection id back from item + layer key. Uses the
 * explicit `<itemId>__<layerKey>` form when a layer key is given,
 * the bare UUID form otherwise.
 */
export function formatCollectionId(itemId: string, layerKey: string | null): string {
  return layerKey ? `${itemId}__${layerKey}` : itemId;
}
