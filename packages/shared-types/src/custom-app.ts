/**
 * Canonical shape stored in a `web_app` Item's data when
 * `template = 'custom'`. The Custom Web App template is the
 * "designer-first" companion to Viewer / Editor / Survey: where
 * those templates ship with a fixed UI and a small config knob set,
 * a Custom app is a free-form layout of widgets the author drags
 * onto a canvas and binds to data sources individually.
 *
 * Inspirations: Esri Web AppBuilder + Experience Builder. The two
 * camps split because Esri tried to support both "quick configurable
 * app from a template" (Web AppBuilder) and "full-bleed designed
 * experience" (Experience Builder); we want one balanced surface
 * that doesn't feel like a stripped-down copy of either. The widgets
 * are extensible (each carries its own `kind` discriminator and
 * config object), so adding a new widget is "ship one widget renderer
 * + one designer panel" rather than reshaping the schema.
 *
 * Authorization: targets list reuses ViewerTarget shape so the same
 * share + geo-limit pipeline applies. Authoring permission is
 * orthogonal -- only owners / admins can edit the layout, but
 * anyone with view permission on the web_app item plus its
 * referenced layers can render it.
 *
 * See docs/web-app-templates.md and #261 for the broader template
 * registry. Custom is template #4 after Editor (#258), Viewer (#259),
 * and Survey (#260).
 */

import type { ViewerTarget } from './viewer';

export interface CustomAppData {
  /** Schema version. Bumped from 1 to 2 (#357) when the canvas grid
   *  resolution doubled (12 -> 24 columns, 48px -> 24px row height)
   *  for finer drag/snap. Migration multiplies every widget's
   *  col / row / colSpan / rowSpan by 2 on load and rewrites
   *  version=2 on the next save. */
  version: 1 | 2;
  /**
   * Optional reference to a `map` item the canvas-style widgets
   * (MapWidget) inherit basemap + viewport from. Individual widgets
   * may override; this is the "default for new map widgets" hint
   * the designer reads when stamping a fresh widget onto the canvas.
   */
  mapId?: string;
  /**
   * Layers the app's widgets can bind to. The designer's "Add
   * widget" flow lists these as choices for layer-bound widgets
   * (Attribute Table, Chart, Legend filter). Mirrors ViewerData's
   * targets shape so a future "convert custom -> viewer" downgrade
   * path stays mechanical.
   */
  targets: ViewerTarget[];
  /**
   * The page tree. v1 supports a single page so the schema is forward-
   * compatible with multi-page apps without forcing every consumer to
   * walk an array today. The home page is always `pages[0]`; the
   * designer's "page chooser" is hidden until pages.length > 1.
   */
  pages: CustomPage[];
  /**
   * App-level theme tokens applied across all pages. Kept tiny in
   * v1; widget-level overrides slot in via widget.style later.
   */
  theme?: {
    /** CSS color value used for primary accents (buttons, focus
     *  rings, active tab underline). Defaults to portal accent. */
    accent?: string;
    /** Background color for the app shell (between widgets). */
    background?: string;
  };
}

export interface CustomPage {
  /** Stable id; URL-safe so future "named page" routing is possible. */
  id: string;
  /** Displayed in the designer's page list and (eventually) the
   *  multi-page chooser at runtime. */
  title: string;
  /**
   * Widgets on this page. Layout positions are stored on the widget
   * itself (CSS grid coordinates). The designer renders this list
   * inside a 12-column grid; the runtime renders it the same way.
   */
  widgets: CustomWidget[];
}

/**
 * Widget envelope. The discriminator is `kind`; each kind carries
 * its own `config` shape. Keeping the envelope (id + position +
 * style) shared lets the designer's drag-drop / resize plumbing
 * not care about widget specifics.
 */
export interface CustomWidget {
  /** Stable id for selection / layout-state / undo-redo. */
  id: string;
  /** Discriminator. Adding a kind: extend CustomWidgetKind +
   *  CustomWidgetConfig + ship a renderer for it. */
  kind: CustomWidgetKind;
  /** CSS grid position on the page's 12-column grid. Row count is
   *  unbounded so widgets stack vertically as the page grows. */
  layout: CustomLayout;
  /**
   * Per-widget style overrides. Theme propagation makes most
   * widgets inherit from app theme, so this stays empty 99% of
   * the time and the designer only exposes it via "Customize".
   */
  style?: {
    background?: string;
    border?: string;
    /** Hide the widget's title bar. Useful when the widget is
     *  decorative (a TextWidget header) and shouldn't carry chrome. */
    hideHeader?: boolean;
  };
  /** Free-form per-widget config; shape depends on `kind`. */
  config: CustomWidgetConfig;
}

/** CSS grid layout descriptor in the page's 12-column grid. */
export interface CustomLayout {
  /** 1-based column number of the widget's top-left cell. */
  col: number;
  /** 1-based row number of the widget's top-left cell. */
  row: number;
  /** Column span; clamped to 12 - col + 1 by the designer. */
  colSpan: number;
  /** Row span; unbounded. */
  rowSpan: number;
}

/**
 * Discriminator for every widget the designer can place. Keep this
 * union narrow; each entry costs a renderer + a designer panel.
 *
 *   - 'map': MapLibre canvas (the workhorse). Bound to one or more
 *     of the app's `targets`.
 *   - 'legend': renders the symbology of every visible layer in a
 *     nominated map widget. Linked by widget id.
 *   - 'layer-list': layer-toggle panel feeding the same map widget.
 *   - 'attribute-table': list rows from one of the app's `targets`,
 *     with selection synced to the linked map widget.
 *   - 'text': a markdown / static-text panel for headers, intros,
 *     attribution, and call-out boxes.
 *   - 'chart': a single-series bar / line / pie chart over a layer's
 *     attributes. Phase 2; ships after the runtime exists.
 *   - 'search': address geocoder + per-target attribute search bar
 *     bound to a map widget. Picking a result pans + highlights.
 *   - 'print': single-button print panel that triggers the bound
 *     map's print stylesheet (#132 once it lands).
 *   - 'select': panel of select-mode buttons (click / rectangle /
 *     polygon / lasso) that drive the bound map's select tool.
 *   - 'basemap-gallery': tile grid of the org's basemap items;
 *     clicking a tile swaps the bound map's basemap.
 */
export type CustomWidgetKind =
  | 'map'
  | 'legend'
  | 'layer-list'
  | 'attribute-table'
  | 'text'
  | 'chart'
  | 'search'
  | 'print'
  | 'select'
  | 'basemap-gallery';

/**
 * Discriminated union of every widget kind's config shape. The
 * runtime + designer narrow on `kind` before reading these fields.
 */
export type CustomWidgetConfig =
  | MapWidgetConfig
  | LegendWidgetConfig
  | LayerListWidgetConfig
  | AttributeTableWidgetConfig
  | TextWidgetConfig
  | ChartWidgetConfig
  | SearchWidgetConfig
  | PrintWidgetConfig
  | SelectWidgetConfig
  | BasemapGalleryWidgetConfig;

export interface MapWidgetConfig {
  kind: 'map';
  /**
   * Optional map item reference. When set, this widget's basemap +
   * viewport + layer ordering come from that map. When unset, the
   * widget falls back to the app-level `mapId` (CustomAppData.mapId)
   * and finally to a minimal default basemap if neither is set.
   */
  mapId?: string;
  /**
   * Layer subset to render. Each entry indexes into the parent
   * app's `targets`. When undefined, every target is shown.
   */
  showTargets?: number[];
  /** Show the standard zoom in/out + home + locate buttons. */
  showNavigation?: boolean;
}

export interface LegendWidgetConfig {
  kind: 'legend';
  /** id of the map widget on the same page this legend follows.
   *  Required: a free-floating legend with no map reference is
   *  meaningless. */
  mapWidgetId: string;
}

export interface LayerListWidgetConfig {
  kind: 'layer-list';
  /** id of the map widget on the same page this layer list controls. */
  mapWidgetId: string;
  /** Allow users to toggle layer visibility. When false, this is a
   *  "see what's loaded" reference panel only. */
  allowToggle?: boolean;
}

export interface AttributeTableWidgetConfig {
  kind: 'attribute-table';
  /** Index into the parent app's `targets` array; identifies the
   *  layer this table renders. */
  targetIndex: number;
  /** Optional map widget id; when set, table selections highlight
   *  + zoom on the linked map. */
  syncWithMapWidgetId?: string;
  /** Maximum rows fetched. Defaults to 200 in the runtime. */
  maxRows?: number;
}

export interface TextWidgetConfig {
  kind: 'text';
  /** Inline markdown. Rendered with a constrained subset (bold,
   *  italic, links, lists, code) so script injection isn't possible. */
  markdown: string;
  /**
   * One of a small set of presentational presets the designer
   * exposes as a dropdown. Lets the author pick "Header" vs
   * "Body" without diving into custom CSS.
   */
  preset?: 'header' | 'subheader' | 'body' | 'callout';
}

export interface ChartWidgetConfig {
  kind: 'chart';
  /** Index into targets (one chart binds to one layer). */
  targetIndex: number;
  /** Chart geometry. v1 supports the most common three; bubble /
   *  scatter land in a follow-up slice. */
  chartType: 'bar' | 'line' | 'pie';
  /** Field name to group by (categorical for bar/pie, ordinal for
   *  line). The designer's field picker reads the layer's schema
   *  and offers compatible columns. */
  groupBy?: string;
  /**
   * Aggregation to render per group. 'count' is universally
   * supported; others require `valueField`.
   */
  aggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max';
  /** Numeric field for non-count aggregates. */
  valueField?: string;
}

export interface SearchWidgetConfig {
  kind: 'search';
  /** id of the map widget the search results pan + highlight on.
   *  Required: a search bar with no map target has nowhere to fly. */
  mapWidgetId: string;
  /** Whether to enable Nominatim address geocoding alongside per-
   *  target attribute search. Default true; turning off removes
   *  the address half and leaves a layer-attribute search bar. */
  geocodingEnabled?: boolean;
}

export interface PrintWidgetConfig {
  kind: 'print';
  /** id of the map widget to print. Phase 1 just calls the bound
   *  map's print stylesheet (window.print scoped via CSS); Phase 2
   *  hooks #132's report_template item once it lands. */
  mapWidgetId: string;
}

export interface SelectWidgetConfig {
  kind: 'select';
  /** id of the map widget the select tool drives. */
  mapWidgetId: string;
  /** Subset of select modes exposed in the panel. Defaults to all
   *  four when omitted. The runtime button order matches this
   *  array order, so authors can promote their preferred mode. */
  modes?: Array<'click' | 'rectangle' | 'polygon' | 'lasso'>;
}

export interface BasemapGalleryWidgetConfig {
  kind: 'basemap-gallery';
  /** id of the map widget whose basemap this gallery swaps. */
  mapWidgetId: string;
  /**
   * Optional allowlist of basemap item ids to surface. When
   * undefined, the gallery shows every basemap visible to the
   * caller in the org. Useful for "we want users to choose from
   * these three branded basemaps" scenarios.
   */
  basemapIds?: string[];
}

/**
 * Freshly-created Custom Web App. One blank page with no widgets;
 * the designer prompts the author to drop a widget on first open.
 */
export const DEFAULT_CUSTOM_APP: CustomAppData = {
  version: 2,
  targets: [],
  pages: [
    {
      id: 'home',
      title: 'Home',
      widgets: [],
    },
  ],
};

/**
 * Migrate a CustomAppData to the latest schema version. v1 -> v2
 * doubles every widget layout coordinate so the same physical layout
 * round-trips through the new 24-column / 24px-row designer grid.
 *
 * Idempotent: calling on an already-v2 app is a no-op. Caller should
 * persist the result back to the item on the next save (the
 * designer's setApp(initial) flow handles that automatically).
 */
export function migrateCustomAppData(data: CustomAppData): CustomAppData {
  if (data.version === 2) return data;
  return {
    ...data,
    version: 2,
    pages: data.pages.map((p) => ({
      ...p,
      widgets: p.widgets.map((w) => ({
        ...w,
        layout: {
          // v1 grid was 12 cols x 48px rows; v2 is 24 x 24. Doubling
          // every coordinate keeps the visual layout identical.
          col: ((w.layout.col - 1) * 2) + 1,
          row: ((w.layout.row - 1) * 2) + 1,
          colSpan: w.layout.colSpan * 2,
          rowSpan: w.layout.rowSpan * 2,
        },
      })),
    })),
  };
}
