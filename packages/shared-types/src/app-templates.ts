// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * App templates — pre-configured CustomAppData instances that seed
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
 * — the seed includes empty / placeholder values that the wizard
 * fills in.
 */
import type { CustomAppData, CustomWidget } from './custom-app';

/** Stable id for a template; persisted in analytics + wizard URLs. */
export type AppTemplateId =
  | 'blank'
  | 'parcel-viewer'
  | 'field-inspection'
  | 'public-info-map';

/**
 * Metadata + seed function for one template. The seed is a function
 * (not a static object) so we can stamp fresh widget ids per
 * instance — otherwise two apps from the same template would share
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
  // App-bar children: Search + Basemaps + Attribute Table button +
  // Print. All as tool-mode widgets so they render as buttons
  // inside the bar.
  const search = childWidget('search', {
    kind: 'search',
    mapWidgetId: '',
    geocodingEnabled: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-center'),
  });
  const basemap = childWidget('basemap-gallery', {
    kind: 'basemap-gallery',
    mapWidgetId: '',
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });
  const attrTable = childWidget('attribute-table', {
    kind: 'attribute-table',
    targetIndex: 0,
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
    mapWidgetId: '',
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });

  // Dock-panel children: Layers + Basemaps as foldable groups so
  // both fit in a 280px-wide dock without overwhelming.
  const layerList = childWidget('layer-list', {
    kind: 'layer-list',
    mapWidgetId: '',
    allowToggle: true,
    displayMode: 'panel',
  });
  const legend = childWidget('legend', {
    kind: 'legend',
    mapWidgetId: '',
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
      title: 'Parcel Viewer',
      subtitle: 'Click a parcel to see ownership details',
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
        childWidget('foldable-group', {
          kind: 'foldable-group',
          title: 'Legend',
          widgets: [legend],
          defaultOpen: false,
        }),
      ],
      title: 'Map tools',
      collapsible: true,
      defaultCollapsed: false,
      widthPx: 280,
    },
  };
  const map: CustomWidget = {
    id: wid(),
    kind: 'map',
    layout: { col: 13, row: 5, colSpan: 36, rowSpan: 60 },
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
  const search = childWidget('search', {
    kind: 'search',
    mapWidgetId: '',
    geocodingEnabled: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-center'),
  });
  const basemap = childWidget('basemap-gallery', {
    kind: 'basemap-gallery',
    mapWidgetId: '',
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });
  const layerList = childWidget('layer-list', {
    kind: 'layer-list',
    mapWidgetId: '',
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
      title: 'Community Map',
      sticky: true,
      variant: 'glass',
    },
  };
  const map: CustomWidget = {
    id: wid(),
    kind: 'map',
    layout: { col: 1, row: 5, colSpan: 48, rowSpan: 60 },
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
  const search = childWidget('search', {
    kind: 'search',
    mapWidgetId: '',
    geocodingEnabled: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-center'),
  });
  const myLocation = childWidget('my-location', {
    kind: 'my-location',
    mapWidgetId: '',
    zoomLevel: 16,
    keepMarker: true,
    displayMode: 'tool',
    panelArrangement: toolPanel('top-right'),
  });
  const attrTable = childWidget('attribute-table', {
    kind: 'attribute-table',
    targetIndex: 0,
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
    mapWidgetId: '',
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
      title: 'Field Inspection',
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
    id: wid(),
    kind: 'map',
    layout: { col: 1, row: 5, colSpan: 48, rowSpan: 60 },
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
    id: 'parcel-viewer',
    label: 'Parcel Viewer',
    description: 'Public-facing parcel lookup with search + ownership details.',
    use: 'Cities, counties, assessors publishing parcel + ownership data.',
    tags: ['public', 'lookup', 'parcels'],
    seed: parcelViewerSeed,
  },
  {
    id: 'public-info-map',
    label: 'Public Info Map',
    description: 'Map-first layout for community / civic information sharing.',
    use: 'Trails, parks, public projects, "what is happening near me".',
    tags: ['public', 'map-first', 'minimal'],
    seed: publicInfoMapSeed,
  },
  {
    id: 'field-inspection',
    label: 'Field Inspection',
    description: 'Internal-staff layout for field data review + record entry.',
    use: 'Asset inspections, environmental monitoring, field surveys.',
    tags: ['internal', 'data-entry', 'mobile-ready'],
    seed: fieldInspectionSeed,
  },
  {
    id: 'blank',
    label: 'Blank App',
    description: 'Start from scratch with an empty canvas and the default theme.',
    use: 'When the existing templates do not match the use case.',
    tags: ['advanced'],
    seed: blankSeed,
  },
];

/** Look up a template by id. Returns the Blank template as a fallback. */
export function getAppTemplate(id: AppTemplateId): AppTemplate {
  return APP_TEMPLATES.find((t) => t.id === id) ?? APP_TEMPLATES[3]!;
}
