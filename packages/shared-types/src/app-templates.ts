// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * App templates: pre-configured CustomAppData instances that seed
 * new Custom Web App items with a thoughtful layout, a theme, and
 * a sensible widget set. Authors pick a template in the new-item
 * wizard; the item gets created from the template's seed, and the
 * author can save-as-is, customize a few inputs (title, map
 * binding, theme), or open Advanced mode to edit anything.
 *
 * Critical design constraint: templates are pre-configured
 * CustomAppData instances. They use the SAME widget kinds and the
 * SAME container kinds the freeform path uses. Anything in a
 * template can be built from scratch in the freeform Custom Web
 * App; anything in the freeform path can be saved as a template.
 * No template-only widgets, no template-only rendering paths.
 *
 * The `mapId` field is always left blank in the seed: the wizard
 * asks the author to pick a map item (or seeds it from a passed
 * default) before persisting. Same for any target binding fields
 * (the seed includes empty / placeholder values that the wizard
 * fills in.
 */
import type { CustomAppData, CustomWidget } from './custom-app';

/**
 * Stable id for a template; persisted in analytics + wizard URLs.
 * Names describe the LAYOUT / INTENT of the template (sidebar
 * explorer, showcase map, compact drawer, blank) rather than a
 * specific data topic. Topic examples live in the template's
 * description + use lines instead; a "Sidebar Explorer" is just
 * as good for asset inventories as it is for parcel viewers, so
 * locking the name to one topic narrows the apparent fit.
 *
 * The earlier topic-named ids (parcel-viewer, public-info-map,
 * field-inspection) are kept as aliases so any in-flight test
 * apps that referenced them still resolve. New saves write the
 * layout-named ids.
 */
export type AppTemplateId =
  | 'blank-canvas'
  | 'sidebar-explorer'
  | 'showcase-map'
  | 'compact-drawer'
  // Legacy aliases for templates created before the layout-named
  // rename. Kept resolvable; getAppTemplate maps these to their
  // new equivalents.
  | 'blank'
  | 'parcel-viewer'
  | 'public-info-map'
  | 'field-inspection';

/**
 * Metadata + seed function for one template. The seed is a function
 * (not a static object) so we can stamp fresh widget ids per
 * instance; otherwise two apps from the same template would share
 * widget ids and the designer's selection state would get confused.
 */
export interface AppTemplate {
  id: AppTemplateId;
  label: string;
  description: string;
  /**
   * Short tagline / use-case description rendered in the template
   * gallery underneath the visual preview.
   */
  use: string;
  /**
   * Tags shown as small pills under the title. Used for filtering
   * the gallery + giving the author a quick read on what's in the
   * template.
   */
  tags: string[];
  /** Build a fresh CustomAppData seeded from this template. */
  seed: () => CustomAppData;
}

/**
 * Mint a short random widget id. Mirrors the designer's
 * convention; templates use this so every stamped widget has a
 * unique id within the seeded app.
 */
function wid(): string {
  return `w_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Generic helper for placing a child widget inside a container.
 * Children inside a container ignore their layout.col/row, but the
 * shape needs to be present on the widget envelope. We stamp a
 * (1, 1, 1, 1) placeholder.
 */
function childWidget(
  kind: CustomWidget['kind'],
  config: CustomWidget['config'],
): CustomWidget {
  return {
    id: wid(),
    kind,
    layout: { col: 1, row: 1, colSpan: 1, rowSpan: 1 },
    config,
  };
}

/**
 * Default panel-arrangement helper used by templates when stamping
 * tool-mode widgets that get popovers. Keeps the templated seeds
 * concise; the runtime falls back to its own defaults for any
 * fields left undefined.
 */
function toolPanel(anchor: 'top-right' | 'bottom-center' | 'top-center') {
  return {
    placement: 'floating' as const,
    anchor,
    width: anchor === 'bottom-center' ? 720 : 320,
    height: anchor === 'bottom-center' ? 280 : 420,
    offsetX: 12,
    offsetY: 12,
    animation: 'fade' as const,
  };
}

/**
 * Parcel Viewer template. Designed for organizations that publish a
 * parcels map for the public + internal staff. The layout:
 *
 *   - App bar across the top with the org logo, title, and a search
 *     widget (geocoder bound to the parcel layer's address fields).
 *   - Dock panel on the left holding Layers and Basemaps, collapse-
 *     to-rail so the map gets the full width when the user is
 *     browsing.
 *   - Map widget fills the remaining canvas, bound to the org's
 *     parcels map item.
 *   - Attribute table widget configured as docked-bottom, opens on
 *     demand from a button in the app-bar's right side.
 *
 * Theme: Default (portal-matching). Authors can swap to Slate /
 * Forest / Paper in the right rail.
 */
function parcelViewerSeed(): CustomAppData {
  // Stamp the map widget id first so every map-bound child can
  // reference it. Without this, the seed leaves mapWidgetId='' on
  // every child and the runtime shows "No bound map" for Layers,
  // Search, Basemap, etc.
  const mapId = wid();

  // App-bar children: Search + Basemaps + Attribute Table button +
  // Print. All as tool-mode widgets so they render as icon buttons
  // inside the bar (renderWidgetInContainer in the runtime wraps
  // tool-mode children in a ToolWidgetSlot).
  const search = childWidget('search', {
    kind: 'search',
    mapWidgetId: mapId,
    geocodingEnabled: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-center'),
  });
  const basemap = childWidget('basemap-gallery', {
    kind: 'basemap-gallery',
    mapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });
  const attrTable = childWidget('attribute-table', {
    kind: 'attribute-table',
    targetIndex: 0,
    syncWithMapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: {
      placement: 'docked-bottom',
      anchor: 'bottom-center',
      width: 720,
      height: 320,
      offsetX: 0,
      offsetY: 0,
      animation: 'fade',
    },
  });
  const print = childWidget('print', {
    kind: 'print',
    mapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });

  // Dock-panel children: a Layers list as a panel-mode widget (it's
  // already inside the dock's own column layout; no popover needed).
  // The LayerList renders its own legend swatches inline per row so
  // we don't need a separate Legend widget in the dock.
  const layerList = childWidget('layer-list', {
    kind: 'layer-list',
    mapWidgetId: mapId,
    allowToggle: true,
    displayMode: 'panel',
  });

  // Top-level containers + map.
  const appBar: CustomWidget = {
    id: wid(),
    kind: 'app-bar',
    layout: { col: 1, row: 1, colSpan: 48, rowSpan: 4 },
    config: {
      kind: 'app-bar',
      widgets: [search, basemap, attrTable, print],
      // No baked-in title here. The runtime falls back to the item's
      // own title via RuntimeInfoContext, so the app-bar takes its
      // identity from the item the author named (re-saving the
      // template instance as "Public Parcels" automatically updates
      // the header, no second edit needed.
      sticky: true,
      variant: 'elevated',
    },
  };
  const dockPanel: CustomWidget = {
    id: wid(),
    kind: 'dock-panel',
    layout: { col: 1, row: 5, colSpan: 12, rowSpan: 60 },
    config: {
      kind: 'dock-panel',
      side: 'left',
      widgets: [
        // Wrap each in a foldable-group so the dock organizes its
        // contents the way an authoring user would expect.
        childWidget('foldable-group', {
          kind: 'foldable-group',
          title: 'Layers',
          widgets: [layerList],
          defaultOpen: true,
        }),
      ],
      // No dock title: foldable group already labels its contents,
      // so a wrapping "Map tools" header reads as redundant chrome.
      // The collapse handle still renders so the user can rail-fold
      // the panel to give the map full width.
      collapsible: true,
      defaultCollapsed: false,
      widthPx: 280,
    },
  };
  // Canvas widget: the map. Layout coords are now canvas-relative
  // (the runtime renders containers as flex siblings of the canvas,
  // so the canvas grid is its own 48-col coordinate system). Map
  // fills the full canvas; the dock-panel sits to its left as a
  // flex sibling rather than occupying canvas columns 1-12.
  const map: CustomWidget = {
    id: mapId,
    kind: 'map',
    layout: { col: 1, row: 1, colSpan: 48, rowSpan: 64 },
    config: { kind: 'map' },
  };

  return {
    version: 3,
    themePresetId: 'default',
    targets: [],
    pages: [
      {
        id: 'home',
        title: 'Home',
        widgets: [appBar, dockPanel, map],
      },
    ],
  };
}

/**
 * Public Info Map template. Map-first, minimal chrome. Just a
 * sticky title bar at top with logo + title + search; map fills
 * the rest; basemap picker as a floating button in the top-right
 * corner of the map. No left dock, no permanent attribute table.
 * Good for "show this map to the public, click around to learn
 * about your community" style apps.
 */
function publicInfoMapSeed(): CustomAppData {
  const mapId = wid();
  const search = childWidget('search', {
    kind: 'search',
    mapWidgetId: mapId,
    geocodingEnabled: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-center'),
  });
  const basemap = childWidget('basemap-gallery', {
    kind: 'basemap-gallery',
    mapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });
  const layerList = childWidget('layer-list', {
    kind: 'layer-list',
    mapWidgetId: mapId,
    allowToggle: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });

  const appBar: CustomWidget = {
    id: wid(),
    kind: 'app-bar',
    layout: { col: 1, row: 1, colSpan: 48, rowSpan: 4 },
    config: {
      kind: 'app-bar',
      widgets: [search, layerList, basemap],
      // No baked-in title; runtime falls back to the item's title.
      sticky: true,
      variant: 'glass',
    },
  };
  const map: CustomWidget = {
    id: mapId,
    kind: 'map',
    layout: { col: 1, row: 1, colSpan: 48, rowSpan: 64 },
    config: { kind: 'map' },
  };

  return {
    version: 3,
    themePresetId: 'aurora',
    targets: [],
    pages: [
      {
        id: 'home',
        title: 'Home',
        widgets: [appBar, map],
      },
    ],
  };
}

/**
 * Field Inspection template. Designed for staff doing field work:
 * a title bar with sync status + search; left slideout drawer
 * holding the inspection workflow (form / record list); attribute
 * table along the bottom for record review; map filling the rest.
 * Theme: Slate (dark, technical).
 */
function fieldInspectionSeed(): CustomAppData {
  const mapId = wid();
  const search = childWidget('search', {
    kind: 'search',
    mapWidgetId: mapId,
    geocodingEnabled: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-center'),
  });
  const myLocation = childWidget('my-location', {
    kind: 'my-location',
    mapWidgetId: mapId,
    zoomLevel: 16,
    keepMarker: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });
  const attrTable = childWidget('attribute-table', {
    kind: 'attribute-table',
    targetIndex: 0,
    syncWithMapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: {
      placement: 'docked-bottom',
      anchor: 'bottom-center',
      width: 720,
      height: 320,
      offsetX: 0,
      offsetY: 0,
      animation: 'fade',
    },
  });
  const layerList = childWidget('layer-list', {
    kind: 'layer-list',
    mapWidgetId: mapId,
    allowToggle: true,
    displayMode: 'panel',
  });

  const appBar: CustomWidget = {
    id: wid(),
    kind: 'app-bar',
    layout: { col: 1, row: 1, colSpan: 48, rowSpan: 4 },
    config: {
      kind: 'app-bar',
      widgets: [search, myLocation, attrTable],
      // No baked-in title; runtime falls back to the item's title.
      sticky: true,
      variant: 'elevated',
    },
  };
  const slideout: CustomWidget = {
    id: wid(),
    kind: 'slideout',
    layout: { col: 1, row: 5, colSpan: 4, rowSpan: 60 },
    config: {
      kind: 'slideout',
      edge: 'left',
      widgets: [
        childWidget('foldable-group', {
          kind: 'foldable-group',
          title: 'Layers',
          widgets: [layerList],
          defaultOpen: true,
        }),
      ],
      triggerLabel: 'Tools',
      triggerIcon: 'tools',
      sizePx: 320,
    },
  };
  const map: CustomWidget = {
    id: mapId,
    kind: 'map',
    layout: { col: 1, row: 1, colSpan: 48, rowSpan: 64 },
    config: { kind: 'map' },
  };

  return {
    version: 3,
    themePresetId: 'slate',
    targets: [],
    pages: [
      {
        id: 'home',
        title: 'Home',
        widgets: [appBar, map, slideout],
      },
    ],
  };
}

/**
 * #22: Editor template.  A working app for staff who add / edit /
 * delete features.  Layout mirrors the legacy `editor` item type:
 * top app-bar with Save / Search / table, left dock for layer
 * toggles, the Attribute Table docked at the bottom by default
 * so authors land on a "see rows + their geometry" workspace.
 *
 * The dedicated Create / Edit / Delete feature widgets are
 * planned (task #56); when they land, the seed is updated to
 * stamp them in the app-bar.  For now the template lays out the
 * working surface and the user wires in editing via the
 * AttributeTable's inline edit affordances + the map's existing
 * select-and-edit path.
 */
function editorWorkspaceSeed(): CustomAppData {
  const mapId = wid();
  const search = childWidget('search', {
    kind: 'search',
    mapWidgetId: mapId,
    geocodingEnabled: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-center'),
  });
  const select = childWidget('select', {
    kind: 'select',
    mapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });
  const basemap = childWidget('basemap-gallery', {
    kind: 'basemap-gallery',
    mapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });
  // Attribute table is docked-bottom by default and open from
  // the start; editors want it visible without a click.
  const attrTable = childWidget('attribute-table', {
    kind: 'attribute-table',
    targetIndex: 0,
    syncWithMapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: {
      placement: 'docked-bottom',
      anchor: 'bottom-center',
      width: 720,
      height: 360,
      offsetX: 0,
      offsetY: 0,
      animation: 'fade',
    },
  });
  const layerList = childWidget('layer-list', {
    kind: 'layer-list',
    mapWidgetId: mapId,
    allowToggle: true,
    displayMode: 'panel',
  });

  const appBar: CustomWidget = {
    id: wid(),
    kind: 'app-bar',
    layout: { col: 1, row: 1, colSpan: 48, rowSpan: 4 },
    config: {
      kind: 'app-bar',
      widgets: [search, select, basemap, attrTable],
      sticky: true,
      variant: 'elevated',
    },
  };
  const dockPanel: CustomWidget = {
    id: wid(),
    kind: 'dock-panel',
    layout: { col: 1, row: 5, colSpan: 12, rowSpan: 60 },
    config: {
      kind: 'dock-panel',
      side: 'left',
      widgets: [
        childWidget('foldable-group', {
          kind: 'foldable-group',
          title: 'Layers',
          widgets: [layerList],
          defaultOpen: true,
        }),
      ],
      collapsible: true,
      defaultCollapsed: false,
      widthPx: 280,
    },
  };
  const map: CustomWidget = {
    id: mapId,
    kind: 'map',
    layout: { col: 1, row: 1, colSpan: 48, rowSpan: 64 },
    config: { kind: 'map' },
  };

  return {
    version: 3,
    themePresetId: 'slate',
    targets: [],
    pages: [
      {
        id: 'home',
        title: 'Home',
        widgets: [appBar, dockPanel, map],
      },
    ],
  };
}

/**
 * #22: Viewer template.  Read-only audience-facing app.  Bar
 * carries Search + Basemaps + Print; left dock holds Layers
 * (toggle visibility only, no editing).  No attribute table by
 * default — viewers can pop one open via the popup on map click,
 * but the chrome stays minimal.
 */
function viewerReadonlySeed(): CustomAppData {
  const mapId = wid();
  const search = childWidget('search', {
    kind: 'search',
    mapWidgetId: mapId,
    geocodingEnabled: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-center'),
  });
  const basemap = childWidget('basemap-gallery', {
    kind: 'basemap-gallery',
    mapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });
  const print = childWidget('print', {
    kind: 'print',
    mapWidgetId: mapId,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });
  const layerList = childWidget('layer-list', {
    kind: 'layer-list',
    mapWidgetId: mapId,
    allowToggle: true,
    displayMode: 'panel',
  });

  const appBar: CustomWidget = {
    id: wid(),
    kind: 'app-bar',
    layout: { col: 1, row: 1, colSpan: 48, rowSpan: 4 },
    config: {
      kind: 'app-bar',
      widgets: [search, basemap, print],
      sticky: true,
      variant: 'elevated',
    },
  };
  const dockPanel: CustomWidget = {
    id: wid(),
    kind: 'dock-panel',
    layout: { col: 1, row: 5, colSpan: 12, rowSpan: 60 },
    config: {
      kind: 'dock-panel',
      side: 'left',
      widgets: [
        childWidget('foldable-group', {
          kind: 'foldable-group',
          title: 'Layers',
          widgets: [layerList],
          defaultOpen: true,
        }),
      ],
      collapsible: true,
      defaultCollapsed: false,
      widthPx: 280,
    },
  };
  const map: CustomWidget = {
    id: mapId,
    kind: 'map',
    layout: { col: 1, row: 1, colSpan: 48, rowSpan: 64 },
    config: { kind: 'map' },
  };

  return {
    version: 3,
    themePresetId: 'default',
    targets: [],
    pages: [
      {
        id: 'home',
        title: 'Home',
        widgets: [appBar, dockPanel, map],
      },
    ],
  };
}

/**
 * Blank template. Empty page + portal-default theme. The "Custom
 * Web App from scratch" path users who don't want to start from a
 * template land in.
 */
function blankSeed(): CustomAppData {
  return {
    version: 3,
    themePresetId: 'default',
    targets: [],
    pages: [{ id: 'home', title: 'Home', widgets: [] }],
  };
}

/**
 * Registry of all built-in templates. The new-item wizard reads
 * this to render the gallery. Templates are listed in the order
 * the wizard should display them: blank last (it's the
 * "no template" path).
 */
export const APP_TEMPLATES: readonly AppTemplate[] = [
  {
    id: 'sidebar-explorer',
    label: 'Sidebar Explorer',
    description:
      'Top bar with map tools, collapsible side panel with layers + legend, full-bleed map, attribute table that slides up from the bottom on demand.',
    use: 'Parcel viewers, asset inventories, environmental layer browsers, anything "show me this data layer with click-to-inspect details".',
    tags: ['sidebar', 'browse', 'inspect'],
    seed: parcelViewerSeed,
  },
  {
    id: 'showcase-map',
    label: 'Showcase Map',
    description:
      'Map-first layout with minimal chrome. Glass-style top bar floats over the map; search, layers, and basemap as overlay buttons.',
    use: 'Community maps, public information portals, project showcases, story maps, "look at this map" presentations.',
    tags: ['map-first', 'minimal', 'public'],
    seed: publicInfoMapSeed,
  },
  {
    id: 'compact-drawer',
    label: 'Compact Drawer',
    description:
      'Map fills the screen; a tool drawer slides in from the edge on demand. Smaller permanent chrome footprint for mobile / focused workflows.',
    use: 'Field-staff apps, mobile-friendly maps, inspection workflows, anywhere screen real estate is at a premium.',
    tags: ['mobile', 'drawer', 'compact'],
    seed: fieldInspectionSeed,
  },
  {
    id: 'blank-canvas',
    label: 'Blank Canvas',
    description:
      'Empty page with the default theme. No containers, no widgets; start from scratch in advanced mode.',
    use: 'When none of the layouts above fit, or you want full control from the first widget drop.',
    tags: ['advanced'],
    seed: blankSeed,
  },
];

// ============================================================
// #22 starter library + blueprint stamping.
// ============================================================
//
// "Starters" are the four built-in templates we seed into every
// org as app_template items on bootstrap.  After seeding, an admin
// can edit / delete / replace them like any other item; the
// `seedKind` column on item carries the stable starter id forward
// so the housekeeping "Restore starter templates" button can
// detect which starters this org is missing.
//
// The wizard does NOT iterate this array directly anymore (the
// wizard reads app_template items from the API).  These exports
// exist for two consumers:
//
//   * org-bootstrap (apps/portal-api) calls each starter's seed
//     function at org-creation time to stamp the four starter
//     items into the new org.
//
//   * admin-restore (apps/portal-api) calls the same seeds when
//     an admin asks to restore a missing starter.

/**
 * Stable identifier persisted on the seeded item's `seedKind`
 * column.  Lets the admin restore flow answer "does this org
 * already have the sidebar-explorer starter?" without scanning
 * content.  Do NOT change a starter's kind after release; rename
 * the label / description instead.
 */
export type StarterKind =
  | 'sidebar-explorer'
  | 'showcase-map'
  | 'compact-drawer'
  | 'editor-workspace'
  | 'viewer-readonly'
  | 'blank-canvas';

/**
 * One starter's metadata + seed function.  The seed returns a
 * fresh CustomAppData with new widget ids per call, so two
 * different orgs (or two restores within the same org) get
 * non-colliding ids.
 */
export interface StarterTemplate {
  kind: StarterKind;
  label: string;
  description: string;
  use: string;
  tags: readonly string[];
  seed: () => CustomAppData;
}

/**
 * The four built-in starters seeded into every org.  Order in this
 * array is the order the admin restore UI displays them in.
 */
export const STARTERS: readonly StarterTemplate[] = [
  {
    kind: 'sidebar-explorer',
    label: 'Sidebar Explorer',
    description:
      'Top app bar with title and tools, left dock panel for layers, map fills the rest of the canvas. The classic sidebar explorer layout.',
    use: 'Parcel viewers, asset inventories, internal data exploration, any "explore a map by toggling layers" workflow.',
    tags: ['explorer', 'dock', 'map-first'],
    seed: parcelViewerSeed,
  },
  {
    kind: 'showcase-map',
    label: 'Showcase Map',
    description:
      'Map-first layout with minimal chrome. Glass-style top bar floats over the map; search, layers, and basemap as overlay buttons.',
    use: 'Community maps, public information portals, project showcases, story maps, "look at this map" presentations.',
    tags: ['map-first', 'minimal', 'public'],
    seed: publicInfoMapSeed,
  },
  {
    kind: 'compact-drawer',
    label: 'Compact Drawer',
    description:
      'Map fills the screen; a tool drawer slides in from the edge on demand. Smaller permanent chrome footprint for mobile / focused workflows.',
    use: 'Field-staff apps, mobile-friendly maps, inspection workflows, anywhere screen real estate is at a premium.',
    tags: ['mobile', 'drawer', 'compact'],
    seed: fieldInspectionSeed,
  },
  {
    kind: 'editor-workspace',
    label: 'Editor',
    description:
      'Workspace layout for staff adding, editing, and deleting features. Top bar with search + select, left dock with layers, attribute table docked at the bottom.',
    use: 'Data maintenance workflows, asset stewardship, anyone whose job is to keep a data layer current.',
    tags: ['editor', 'data-maintenance'],
    seed: editorWorkspaceSeed,
  },
  {
    kind: 'viewer-readonly',
    label: 'Viewer',
    description:
      'Read-only audience-facing app. Search + basemap + print in the top bar, layer toggles in the side dock, no editing affordances.',
    use: 'Public information maps, internal share-only views, anywhere the audience reads but does not write.',
    tags: ['viewer', 'read-only', 'public'],
    seed: viewerReadonlySeed,
  },
  {
    kind: 'blank-canvas',
    label: 'Blank Canvas',
    description:
      'Empty page with the default theme. No containers, no widgets; start from scratch in advanced mode.',
    use: 'When none of the layouts above fit, or you want full control from the first widget drop.',
    tags: ['advanced'],
    seed: blankSeed,
  },
];

/**
 * Look up a starter by its kind.  Returns null when the kind isn't
 * one of the four built-ins; callers should treat that as "this
 * isn't a starter, it's a user-saved template" and skip the
 * restore-from-seed path.
 */
export function getStarter(kind: string): StarterTemplate | null {
  return STARTERS.find((s) => s.kind === kind) ?? null;
}

/**
 * Mint fresh widget ids across a CustomAppData blueprint while
 * preserving cross-widget references (mapWidgetId, syncWithMap-
 * WidgetId, etc.).  Used when stamping a saved template into a
 * fresh app: the template's widget ids are reused inside its own
 * tree, but two app instances should not share ids.
 *
 * Strategy: walk the tree, build an id remap (oldId -> newId) for
 * every widget, then walk again and rewrite both each widget's own
 * id and any string fields on `config` that look like a known id
 * reference.  Container widgets carry `widgets: CustomWidget[]`
 * children that get the same treatment recursively.
 */
export function stampBlueprint(blueprint: CustomAppData): CustomAppData {
  const idRemap = new Map<string, string>();

  function collectIds(widgets: readonly CustomWidget[]): void {
    for (const w of widgets) {
      idRemap.set(w.id, wid());
      const cfg = w.config as { widgets?: CustomWidget[] };
      if (Array.isArray(cfg.widgets)) collectIds(cfg.widgets);
    }
  }

  function remapRefsInConfig(cfg: unknown): unknown {
    if (cfg === null || typeof cfg !== 'object') return cfg;
    if (Array.isArray(cfg)) return cfg.map((v) => remapRefsInConfig(v));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
      if (
        (k === 'mapWidgetId' ||
          k === 'syncWithMapWidgetId' ||
          k === 'targetWidgetId') &&
        typeof v === 'string' &&
        idRemap.has(v)
      ) {
        out[k] = idRemap.get(v);
      } else {
        out[k] = remapRefsInConfig(v);
      }
    }
    return out;
  }

  function rewriteWidgets(widgets: readonly CustomWidget[]): CustomWidget[] {
    return widgets.map((w) => {
      const newId = idRemap.get(w.id) ?? wid();
      const cfg = w.config as { widgets?: CustomWidget[] };
      // Rewrite cross-widget id references on config.  For
      // containers, recurse into config.widgets to mint child ids.
      const rewrittenCfg = remapRefsInConfig(cfg) as typeof cfg;
      if (Array.isArray(cfg.widgets)) {
        rewrittenCfg.widgets = rewriteWidgets(cfg.widgets);
      }
      return {
        ...w,
        id: newId,
        config: rewrittenCfg as CustomWidget['config'],
      };
    });
  }

  // Collect ids first across every page so cross-page references
  // (rare but possible) also remap consistently.
  for (const p of blueprint.pages) collectIds(p.widgets);

  return {
    ...blueprint,
    pages: blueprint.pages.map((p) => ({
      ...p,
      widgets: rewriteWidgets(p.widgets),
    })),
  };
}

/**
 * Look up a template by id. Maps legacy topic-named ids
 * (parcel-viewer, public-info-map, field-inspection, blank) to
 * their layout-named successors so already-created apps keep
 * resolving. Returns Blank Canvas as a final fallback.
 */
export function getAppTemplate(id: AppTemplateId): AppTemplate {
  const legacyMap: Record<string, AppTemplateId> = {
    'parcel-viewer': 'sidebar-explorer',
    'public-info-map': 'showcase-map',
    'field-inspection': 'compact-drawer',
    blank: 'blank-canvas',
  };
  const resolved = legacyMap[id] ?? id;
  return (
    APP_TEMPLATES.find((t) => t.id === resolved) ??
    APP_TEMPLATES[APP_TEMPLATES.length - 1]!
  );
}
