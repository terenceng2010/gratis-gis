// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tool items (#90).
 *
 * A "tool" is a reusable, named action.  Drop one on a web app via
 * the Button widget (`linkKind: 'tool'`, `toolId: '...'`) and the
 * tool's `action` determines what happens on click.  The reuse is
 * the point: the same "Open the WV parcel viewer" or "Print the
 * monthly report template" recipe can sit on a dashboard, an admin
 * page, and a field workflow without re-authoring three times.
 *
 * v1 actions are URL-shaped on purpose -- "navigate the user to
 * somewhere" covers a lot of "show me the thing" workflows and
 * needs no execution backend.  Later actions (run a derived-layer
 * pipeline, kick off a notebook, trigger a print job) can land
 * additively without changing the shape of existing tools.
 */

/**
 * What the tool does when triggered.  Discriminated on `kind`.
 */
export type ToolAction =
  | OpenItemAction
  | OpenUrlAction;

/**
 * Open another portal item in the same browser tab.  Resolves to
 * `/items/<targetItemId>` -- the same URL the user would reach by
 * clicking the item in the items grid.  Use this for "go look at
 * the canonical asset" workflows: open a map, open a dashboard,
 * open the public landing page for a layer.
 */
export interface OpenItemAction {
  kind: 'open-item';
  /** Item id to navigate to. */
  targetItemId: string;
  /** When true, opens in a new tab via window.open. */
  newTab?: boolean;
  /** Optional ?view= override, eg 'configure' or 'run'.  Lets a
   *  tool aim at a specific surface of a multi-view item. */
  view?: string;
}

/**
 * Open an absolute URL.  This is the escape hatch -- author drops
 * an internal /items/* path with query params (for selection,
 * highlighting, etc.) OR an external URL to a third-party tool.
 * The URL is opened either in the same tab or a new tab; we don't
 * server-side validate it.
 */
export interface OpenUrlAction {
  kind: 'open-url';
  /** Absolute or app-relative URL.  Empty string is a no-op (the
   *  button still renders, but clicking does nothing -- helpful
   *  for half-configured tools so the UI doesn't crash). */
  url: string;
  /** When true, opens in a new tab via target="_blank". */
  newTab?: boolean;
}

/**
 * Stored data shape for a `tool` item.  Item core fields (id,
 * title, description, owner, sharing) live on the item table; this
 * is the `data` blob.
 */
export interface ToolItemData {
  /** Schema version.  Bumped whenever the action shape changes
   *  incompatibly so the runtime can refuse stale tool configs
   *  cleanly. */
  schemaVersion: 1;
  /** The thing the tool does on trigger. */
  action: ToolAction;
  /**
   * Optional short blurb shown next to the tool's name in pickers
   * (the Button widget's "Pick a tool" dropdown, the tool detail
   * page header).  When empty, the tool's item description is used
   * as a fallback.
   */
  hint?: string;
}

/** Returns a freshly-stubbed tool data blob -- used by the
 *  new-item wizard.  Defaults to an open-url action with an
 *  empty URL so the user lands on the detail page with a tool
 *  that's safe to save and clearly half-finished. */
export function emptyToolData(): ToolItemData {
  return {
    schemaVersion: 1,
    action: { kind: 'open-url', url: '', newTab: true },
  };
}
