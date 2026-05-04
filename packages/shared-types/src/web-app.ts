/**
 * Canonical shape stored in an Item's `data` when `type = 'web_app'`.
 *
 * #258: web_app is the umbrella type for "templated app on top of an
 * item". When the data carries a `template` discriminator + a
 * `config` object whose shape is the template's, downstream code
 * routes to template-specific UI / endpoints. See
 * docs/item-type-guidance.md for the decision pattern.
 *
 * Today the registry is small (just `editor`); future templates
 * (Dashboard, Survey-response viewer, Story map) plug in by adding
 * a discriminator value here + a config sub-shape.
 *
 * Untemplated `web_app` items (no `template` field) keep working as
 * a freeform external-link surface. The detail UI shows a generic
 * "open" affordance.
 */

import type { EditorData } from './editor';

/**
 * Tag of which template a web_app implements. Each value pairs with
 * a config sub-shape in WebAppData.config. Adding a value: extend
 * this union and the WebAppData['config'] discriminated branch.
 */
export type WebAppTemplate = 'editor';

/**
 * Top-level shape on a web_app's `data` field.
 *
 * Versioned for forward-compat: the field is optional today, and
 * older web_app rows that never carried a `version` keep working.
 * Bumping `version` lets us introduce migrators on read.
 */
export interface WebAppData {
  /** Optional schema version; bump on breaking shape changes. */
  version?: 1;
  /**
   * Which template this web_app implements. When unset, the item is
   * a generic "external link" web app and `config` is ignored.
   */
  template?: WebAppTemplate;
  /**
   * Template-specific configuration. The shape depends on
   * `template`; consumers should narrow via the discriminator
   * before reading nested fields.
   */
  config?: WebAppConfig;
  /**
   * Backward-compat catch-all for the historic "external URL" web_app
   * shape: a simple string the detail UI opens in a new tab. Kept on
   * the top level so older items render unchanged. New templated
   * web_apps don't use this.
   */
  url?: string;
}

/**
 * Discriminated union of every template's config shape. Add a new
 * branch when introducing a new template.
 */
export type WebAppConfig =
  | { template: 'editor'; editor: EditorData }
  | { template: string; [key: string]: unknown };

/**
 * Type guard: was this item created or migrated as the editor
 * template? Pulls the editor config or returns null.
 *
 * Accepts the broad `Item` shape (not narrowed to a generic) so the
 * helper can be reused on ItemWithShares, list rows, etc. Backward
 * compat: still recognizes the legacy top-level `type === 'editor'`
 * during the deprecation window so any not-yet-migrated rows surface
 * the same way as migrated ones.
 */
export function isEditorItem(item: {
  type: string;
  data?: unknown;
}): boolean {
  if (item.type === 'editor') return true;
  if (item.type !== 'web_app') return false;
  const d = item.data as WebAppData | null | undefined;
  return d?.template === 'editor';
}

/**
 * Read the EditorData out of either layout: a legacy editor item
 * (data is EditorData directly) or a migrated web_app+editor item
 * (data is WebAppData with config.editor). Returns null when the
 * item isn't an editor (or when the data is missing/malformed).
 *
 * Centralizing this read so callers don't sprinkle their own
 * "is it the legacy shape or the new shape" checks across the
 * codebase. Once the deprecation window closes and we drop the
 * legacy branch, this is the single place to update.
 */
export function readEditorData(item: {
  type: string;
  data?: unknown;
}): EditorData | null {
  if (item.type === 'editor') {
    return (item.data as EditorData | null | undefined) ?? null;
  }
  if (item.type !== 'web_app') return null;
  const d = item.data as WebAppData | null | undefined;
  if (d?.template !== 'editor') return null;
  // The migrated shape stores EditorData under config.editor; defend
  // against an older partial migration that put it under config
  // directly.
  const cfg = d.config as
    | { template: 'editor'; editor?: EditorData }
    | null
    | undefined;
  if (cfg?.template === 'editor' && cfg.editor) return cfg.editor;
  // Fallback: data.config IS the EditorData (shouldn't happen if
  // migration ran correctly, but tolerate).
  if (cfg && typeof cfg === 'object' && 'targets' in cfg) {
    return cfg as unknown as EditorData;
  }
  return null;
}
