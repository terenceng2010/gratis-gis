// SPDX-License-Identifier: AGPL-3.0-or-later
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
import type { AssetRef } from './asset-ref';

export interface CustomAppData {
  /** Schema version. Bumped from 1 to 2 (#357) when the canvas grid
   *  resolution doubled (12 -> 24 columns, 48px -> 24px row height)
   *  for finer drag/snap. Bumped again from 2 to 3 (user feedback:
   *  toolbar buttons could only snap to a column-width gap from the
   *  canvas edge or to the edge itself, with no in-between
   *  position) when the grid doubled again to 48 columns + 12px
   *  rows. Migration multiplies every widget's col / row / colSpan /
   *  rowSpan by 2 per version bump and rewrites the version on the
   *  next save. */
  version: 1 | 2 | 3;
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
  /**
   * Theme reference.  Either:
   *   - a built-in starter kind ('default' / 'slate' / 'aurora' /
   *     'forest' / 'paper') matching seedKind on a seeded theme
   *     item (legacy storage for apps saved before #22 lifted
   *     themes into items), or
   *   - a UUID pointing at a `theme` item the user has access to.
   *
   * The runtime resolves either form against the user's theme
   * catalog (server-side preload).  The older `theme.accent` /
   * `theme.background` overrides still apply on top when set.
   */
  themePresetId?: string;
}

/**
 * Built-in theme presets shipped with the portal. The actual token
 * values live in `app-themes.ts`; this union is the wire-stable id
 * authors save. New presets add new values; renames need a migration
 * step.
 */
export type AppThemePresetId =
  | 'default'
  | 'slate'
  | 'aurora'
  | 'forest'
  | 'paper';

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
  | 'basemap-gallery'
  // #361: page-element widgets. None of these touch a Map widget or
  // a target layer; they're static content the author drops onto the
  // canvas to round out the page. EB calls these "page element"
  // widgets and groups them in their own bucket; we mirror that.
  | 'image'
  | 'button'
  | 'divider'
  | 'embed'
  // #361 part 2: mapcentric quick wins. Each binds to a Map widget
  // by id (mapWidgetId) and reads or drives that map's state.
  | 'bookmark'
  | 'coordinates'
  | 'my-location'
  // #87: time-slider drives the app-wide bitemporal "as of" state.
  // No map binding -- when present, every map/chart/table widget on
  // the page reads the slider value via AppTimeContext and re-fetches
  // against that bitemporal projection.  Author configures min/max
  // bounds and a step.  Renders a date input + slider (or just a
  // calendar / picker, depending on mode).
  | 'time-slider'
  // #69 / #70 / #71: feature editing widgets.  Each binds to a Map
  // widget + a target layer (via the parent app's `targets` array).
  // Create opens an empty attribute form; Edit reads the bound
  // map's selection and pre-fills the form; Delete also reads the
  // selection and confirms+removes.  All three disable themselves
  // when AppTimeContext.at is non-null (the engine rejects past-
  // target writes anyway; this is the UX gate so authors don't
  // even see the buttons in time-travel mode).
  | 'create-feature'
  | 'edit-feature'
  | 'delete-feature'
  // #362: layout container. Holds nested widgets organized into
  // tabs. Anti-EB: deliberately simpler than EB's Section + Views
  // pair, just one widget that renders a tab strip and routes
  // child widgets into the active tab.
  | 'tabs'
  // Themed-app containers. These hold OTHER widgets (just like
  // 'tabs') but render them inside a themed chrome region — an
  // app-bar across the top of the page, a docked panel on a side,
  // a slideout drawer, or a collapsible group. The author drops
  // an existing widget kind (search, layer-list, etc.) INTO the
  // container; the container handles spacing + chrome + theme
  // styling so individual widgets stop looking like separate
  // floating boxes. The same building blocks are available in
  // both the templated and freeform flows — templates are just
  // pre-configured CustomAppData instances with containers
  // already laid out.
  | 'app-bar'
  | 'dock-panel'
  | 'slideout'
  | 'foldable-group';

// ---- Tool-mode display (#364) ----------------------------------

/**
 * Where a tool-mode panel docks within the runtime viewport.
 * The 9-cell grid mirrors EB's panel arrangement picker.
 */
export type PanelAnchor =
  | 'top-left' | 'top-center' | 'top-right'
  | 'middle-left' | 'middle-center' | 'middle-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

/**
 * Placement strategy:
 *   - 'floating': position absolute, relative to the runtime
 *     container. Scrolls with the page.
 *   - 'fixed': position fixed, relative to the browser viewport.
 *     Stays put on scroll. Useful for sticky tool panels.
 */
/**
 * Where the popover panel anchors at runtime when a tool-mode
 * widget is clicked:
 *   - 'floating': inside the runtime container at one of nine
 *     anchor corners + an offset (the default; gives the author
 *     full control over position).
 *   - 'fixed': pinned to the browser viewport rather than the
 *     runtime container; useful when the app is embedded in a
 *     scrolling parent.
 *   - 'docked-bottom': full-width strip docked along the bottom
 *     edge of the runtime container, height configurable.
 *     Mirrors the map item's attribute-table dock; the runtime
 *     renders a collapse/expand handle so the user can shrink it
 *     to a header strip without losing the layer / query state
 *     inside. Width / anchor / offsetX are ignored in this mode;
 *     only the height applies.
 */
export type PanelPlacement = 'floating' | 'fixed' | 'docked-bottom';

/**
 * Open/close transition for tool-mode panels.
 */
export type PanelAnimation = 'none' | 'fade' | 'slide';

/**
 * Per-widget panel arrangement for tool mode (#364). Mirrors the
 * controls EB's Widget Controller exposes, but applied per-widget
 * here instead of as a single setting on a controller container.
 * That gives authors per-tool flexibility: the Layers panel can
 * dock top-right while the Search panel floats next to its button.
 *
 * All fields are optional; the runtime falls back to sensible
 * defaults (floating, top-right of the runtime container, 360x480,
 * fade animation, no offset).
 */
export interface PanelArrangement {
  placement?: PanelPlacement;
  anchor?: PanelAnchor;
  /** Width in CSS pixels. Default 360. Ignored when
   *  placement = 'docked-bottom' (the panel always spans the
   *  runtime container's full width). */
  width?: number;
  /** Height in CSS pixels. Default 480. */
  height?: number;
  /** Pixel nudge from the anchor corner. Positive values move the
   *  panel inward; the runtime applies the sign for each anchor.
   *  Ignored when placement = 'docked-bottom'. */
  offsetX?: number;
  offsetY?: number;
  animation?: PanelAnimation;
  /**
   * Label rendering for the tool button. 'icon-and-label' (the
   * default) shows the icon plus a small caption underneath, the
   * way Esri Experience Builder's tool buttons render. 'icon-only'
   * drops the caption and falls back to a tooltip + aria-label,
   * so the button can compress to a single icon's worth of space.
   * Useful when packing many tools onto a tight toolbar.
   *
   * Only relevant when the widget is in tool display mode; ignored
   * for panel-mode widgets.
   */
  labelMode?: 'icon-and-label' | 'icon-only';
}

/**
 * Widget display modes:
 *   - 'panel': widget renders inline in the canvas grid (existing
 *     behavior). Default for legacy widgets without the field.
 *   - 'tool': widget renders as a small icon button inline; click
 *     opens a popover panel positioned per `panelArrangement`.
 *     Default for newly-stamped map-following widgets so authors
 *     don't have to flip the toggle.
 */
export type DisplayMode = 'panel' | 'tool';

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
  | BasemapGalleryWidgetConfig
  | ImageWidgetConfig
  | ButtonWidgetConfig
  | DividerWidgetConfig
  | EmbedWidgetConfig
  | BookmarkWidgetConfig
  | CoordinatesWidgetConfig
  | MyLocationWidgetConfig
  | TimeSliderWidgetConfig
  | CreateFeatureWidgetConfig
  | EditFeatureWidgetConfig
  | DeleteFeatureWidgetConfig
  | TabsWidgetConfig
  | AppBarWidgetConfig
  | DockPanelWidgetConfig
  | SlideoutWidgetConfig
  | FoldableGroupWidgetConfig;

/**
 * Time-slider widget config (#87).  Sets the app-wide `at` state
 * that Map / Chart / AttributeTable widgets read via AppTimeContext.
 *
 * - mode 'date' renders a date input with a horizontal slider
 *   between `minDate` and `maxDate` at the given `stepDays` cadence.
 * - mode 'calendar' renders a single date picker without the slider
 *   (lighter UI; useful when the author only wants snap-to-day
 *   navigation, not scrubbing).
 *
 * Both modes anchor the chosen day at end-of-day local time so a
 * "March 5" pick reads what the world looked like at the close of
 * that day, matching the wizard's preview convention.  The widget
 * publishes null when set to "Now" (the default), and a full ISO
 * string when set to any past date.
 */
export interface TimeSliderWidgetConfig {
  kind: 'time-slider';
  mode?: 'date' | 'calendar';
  /** YYYY-MM-DD lower bound for the slider track. */
  minDate?: string;
  /** YYYY-MM-DD upper bound; defaults to "today" at render time. */
  maxDate?: string;
  /** Slider step in days (mode='date' only). Defaults to 1. */
  stepDays?: number;
  /** Optional label override; default 'Time'. */
  label?: string;
}

/**
 * Create-feature widget config (#69).  Opens an attribute form for
 * a new row on the chosen target layer.  For point-geometry layers
 * the user clicks once on the bound map to set the location after
 * filling attributes; for table-only (no geometry) layers the form
 * submits directly.  The widget reads AppTimeContext.at and renders
 * disabled when non-null (engine rejects past-target writes).
 */
export interface CreateFeatureWidgetConfig {
  kind: 'create-feature';
  /** Map widget id the click-to-place mode hooks into. */
  mapWidgetId: string;
  /**
   * Optional single-target binding (legacy).  When set, the widget
   * skips the templates picker and immediately enters create mode
   * for the named target.  When omitted (the recommended modern
   * shape), the widget opens a templates palette of every editable
   * target in the bound map -- the author drops one widget per app
   * regardless of how many editable layers it covers.
   */
  targetIndex?: number;
  /** Optional button label override. Default "Add feature". */
  label?: string;
  /** Display mode (panel vs. tool). */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

/**
 * Edit-feature widget config (#70).  Reads the bound map's
 * `selection` state; when exactly one feature is selected, opens
 * an attribute form pre-filled with its properties.  Multi-select
 * is supported as bulk-edit-by-shared-fields in a follow-up; the
 * first slice handles one-at-a-time edits.  Disabled in time-travel
 * mode.
 */
export interface EditFeatureWidgetConfig {
  kind: 'edit-feature';
  mapWidgetId: string;
  /**
   * Optional single-target binding (legacy).  When set, only
   * features in that target are click-editable.  When omitted (the
   * recommended modern shape), every editable target in the bound
   * map participates -- the user clicks any editable feature and
   * the form opens against the layer that feature lives in.
   */
  targetIndex?: number;
  label?: string;
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

/**
 * Delete-feature widget config (#71).  Reads the bound map's
 * selection and offers a Delete button with a count + confirm.
 * Issues one DELETE per selected feature; the engine writes a
 * 'delete' observation rather than truly removing the row, so the
 * deletion is reversible by changing the app-time slider back
 * before the delete timestamp.  Disabled in time-travel mode.
 */
export interface DeleteFeatureWidgetConfig {
  kind: 'delete-feature';
  mapWidgetId: string;
  /**
   * Optional single-target binding (legacy).  When set, only that
   * target's selected features are deleted on confirm.  When
   * omitted (the recommended modern shape), the widget acts against
   * every selected feature across every target in the bound map,
   * dispatching DELETEs per (data_layer, layer) pair.
   */
  targetIndex?: number;
  label?: string;
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

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
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

export interface LayerListWidgetConfig {
  kind: 'layer-list';
  /** id of the map widget on the same page this layer list controls. */
  mapWidgetId: string;
  /** Allow users to toggle layer visibility. When false, this is a
   *  "see what's loaded" reference panel only. */
  allowToggle?: boolean;
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
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
  /**
   * #261 follow-up: attribute-table joins the map-following crew so
   * authors can drop it on the toolbar instead of stealing a row of
   * grid real estate. When `displayMode === 'tool'`, the widget
   * renders as an icon button and the table opens in a floating
   * panel configured by `panelArrangement`. Default arrangement
   * anchors the panel to the bottom edge of the canvas, matching
   * where the map-item's attribute table docks.
   */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
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
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

export interface PrintWidgetConfig {
  kind: 'print';
  /** id of the map widget to print. Phase 1 just calls the bound
   *  map's print stylesheet (window.print scoped via CSS); Phase 2
   *  hooks #132's report_template item once it lands. */
  mapWidgetId: string;
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

export interface SelectWidgetConfig {
  kind: 'select';
  /** id of the map widget the select tool drives. */
  mapWidgetId: string;
  /** Subset of select modes exposed in the panel. Defaults to all
   *  four when omitted. The runtime button order matches this
   *  array order, so authors can promote their preferred mode. */
  modes?: Array<'click' | 'rectangle' | 'polygon' | 'lasso'>;
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
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
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

// ---- Page-element widgets (#361) -------------------------------

/**
 * Static image. Source is a URL the author pastes (a portal item's
 * thumbnail, an external CDN URL, etc.). Local upload is left for a
 * follow-up; for now authors paste a URL the same way they would in
 * a Markdown image.
 */
export interface ImageWidgetConfig {
  kind: 'image';
  /**
   * Image source. New code paths use the AssetRef discriminated
   * union (file-item id with cached URL, OR a direct external URL)
   * so the system knows which apps depend on which File items.
   * The legacy `url?: string` field below is preserved for older
   * configs that haven't been resaved; runtime + designer fall
   * back to it when `asset` is missing.
   */
  asset?: AssetRef;
  /**
   * Legacy direct URL. Kept for back-compat with existing saved
   * widgets; new configs save through `asset` (AssetPicker emits
   * an AssetRef). The runtime resolves `asset` first, falls back
   * to `url` when `asset` is missing.
   */
  url?: string;
  /** Alt text for accessibility. Empty alt is fine for purely
   *  decorative images; the runtime falls back to '' when omitted. */
  alt?: string;
  /** How the image fits its widget cell. Defaults to 'contain' so
   *  letterboxing is the default and aspect-ratios survive resize. */
  objectFit?: 'contain' | 'cover' | 'fill' | 'none';
  /** Optional click target. Behaves like a Button widget when set:
   *  wraps the image in an <a> with href + target. */
  href?: string;
  /** When true, opens href in a new tab. */
  openInNewTab?: boolean;
}

/**
 * Inline call-to-action button. Two link modes:
 *   - external URL: opens the URL (in a new tab if requested)
 *   - internal page: navigates the runtime to one of the app's
 *     pages by id. Useful for "Next" / "Back" style flows in
 *     multi-page apps.
 */
export interface ButtonWidgetConfig {
  kind: 'button';
  /** Visible label. */
  label: string;
  /** Click target. Either an external URL or a page id from the
   *  app's pages array. The runtime narrows on `linkKind`. */
  linkKind?: 'url' | 'page';
  /** External URL (when linkKind='url'). */
  url?: string;
  /** Page id (when linkKind='page'). Falls back to no-op if the
   *  page has been deleted since the button was configured. */
  pageId?: string;
  /** Visual variant. 'primary' is filled with the app's accent;
   *  'secondary' is outlined. */
  variant?: 'primary' | 'secondary';
  /** Open external links in a new tab. Ignored for page links. */
  openInNewTab?: boolean;
}

/**
 * Horizontal rule. Lets authors break up a page without resorting
 * to a Text widget with `---` markdown.
 */
export interface DividerWidgetConfig {
  kind: 'divider';
  /** Stroke thickness in px. Default 1. */
  thicknessPx?: number;
  /** CSS color for the stroke. Defaults to the app's border color. */
  color?: string;
  /** Style of the rule. */
  style?: 'solid' | 'dashed' | 'dotted';
}

/**
 * Embedded iframe content (videos, dashboards, forms, slide decks).
 * The author pastes a URL; the runtime renders an iframe with a
 * conservative sandbox. Cross-origin embedding obeys the target's
 * X-Frame-Options / CSP -- some sites refuse to embed and the
 * author sees a blank frame. We can't probe ahead-of-time without
 * a server-side check, so we surface a hint instead and trust the
 * author to verify.
 */
export interface EmbedWidgetConfig {
  kind: 'embed';
  /** Iframe src. http(s) only; the designer rejects non-http URLs. */
  url?: string;
  /** Optional title attribute for assistive tech. */
  title?: string;
  /** When true, the iframe runs in a stricter sandbox (allow-same-
   *  origin off). Authors who embed trusted dashboards typically
   *  leave this off; opt in for arbitrary third-party URLs. */
  strict?: boolean;
}

// ---- Mapcentric quick wins (#361 part 2) ----------------------

/**
 * One-click viewport bookmarks for a map. Authors capture the bound
 * Map widget's current viewport at design time + give it a name; at
 * runtime each entry is a button that flies the bound map there.
 *
 * Inspired by Esri's Bookmark widget, scoped to the basics for v1
 * (no folder grouping, no per-entry thumbnail, no time-aware
 * extents). Add those if real authors miss them.
 */
export interface BookmarkWidgetConfig {
  kind: 'bookmark';
  /** id of the Map widget this bookmark list flies. */
  mapWidgetId: string;
  /** Saved viewports. Order is the runtime render order. */
  bookmarks: Array<{
    /** Stable id. Lets the designer reorder + delete without
     *  losing identity. */
    id: string;
    /** Display name shown in the runtime button list. */
    name: string;
    /** [lng, lat] center. Same shape MapData uses. */
    center: [number, number];
    /** Zoom level. */
    zoom: number;
    /** Optional camera bearing in degrees clockwise from north. */
    bearing?: number;
    /** Optional camera pitch in degrees from vertical. */
    pitch?: number;
  }>;
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

/**
 * Live coordinate readout. Tracks the cursor position over the
 * bound Map widget and renders the formatted lat/lon. Optional
 * zoom-level chip for "where am I in scale" feedback.
 *
 * v1 supports decimal-degrees and degrees-minutes-seconds. MGRS /
 * UTM are typed but deferred -- they're a half-day of conversion
 * code each and most users want plain DD.
 */
export interface CoordinatesWidgetConfig {
  kind: 'coordinates';
  /** id of the Map widget whose pointer position this tracks. */
  mapWidgetId: string;
  /** Display format. Defaults to 'dd' (decimal degrees). */
  format?: 'dd' | 'dms';
  /** Decimal places for DD; whole-second precision for DMS.
   *  Default: 5 for DD, 0 for DMS. */
  precision?: number;
  /** When true, also displays a small "Zoom: N.NN" chip alongside
   *  the coordinates. Default false. */
  showZoom?: boolean;
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

/**
 * "Show my location" button. On click, requests the browser's
 * Geolocation API and flies the bound Map widget to the result at
 * a configurable zoom. Drops a temporary marker so the user can
 * see where the device thinks it is.
 *
 * v1 is one-shot (single click = single fly). Continuous-tracking
 * mode (watch position, follow as user moves) is a v2 enhancement.
 */
export interface MyLocationWidgetConfig {
  kind: 'my-location';
  /** id of the Map widget to fly + drop the marker on. */
  mapWidgetId: string;
  /** Zoom level the bound map flies to on success. Default 14. */
  zoomLevel?: number;
  /** When true, the marker stays visible until the user clicks
   *  the button again or the page reloads. Default true. */
  keepMarker?: boolean;
  /** #364: tool-mode display. */
  displayMode?: DisplayMode;
  panelArrangement?: PanelArrangement;
}

// ---- Tabs container (#362) ------------------------------------

/**
 * Tabs container. A widget that holds N tabs, each tab holding its
 * own array of CustomWidgets. Anti-EB: deliberately simpler than
 * Section + Views. Authors drag the Tabs widget onto the canvas,
 * pick the active tab, drop child widgets into the content area of
 * that tab. Each tab can hold any of the standard widget kinds
 * (Map, Layers, Text, etc.) and they stack vertically inside.
 *
 * v1 limitations:
 *   - Nested widgets stack vertically in the order they were
 *     dropped. Drag-to-reorder inside a tab is a follow-up.
 *   - No nested tabs (tabs-inside-tabs). The runtime will render
 *     them but the designer drop-routing only goes one level deep
 *     to keep the mental model simple.
 *   - No EB-style sub-grid (each tab a 12-column grid). Stack
 *     layout covers most "tabbed info panel" use cases; sub-grid
 *     can come if real authors miss it.
 */
export interface TabsWidgetConfig {
  kind: 'tabs';
  /** Ordered list of tabs. Always non-empty in practice; the
   *  designer initializes a fresh widget with one default tab. */
  tabs: Array<{
    /** Stable id; preserved across rename + reorder. */
    id: string;
    /** Display name in the tab strip. */
    title: string;
    /** Child widgets for this tab. Rendered in document order. */
    widgets: CustomWidget[];
  }>;
}

// ---- Themed-app container widgets -----------------------------
//
// All four containers below share the same pattern: their config
// includes a `widgets: CustomWidget[]` array of children, and the
// container's renderer places those children inside themed chrome
// (an app bar, a side dock, a slideout drawer, a foldable group).
// Child widgets are full CustomWidget instances — the same building
// blocks the freeform canvas uses — so anything available in a
// template is available in custom mode, and vice versa.
//
// Children inside a container ignore `layout.col / row / colSpan /
// rowSpan` — the container's own layout (row / column / stacked)
// determines child placement. The grid coords stay on the widget
// object so the same widget can be dragged out of a container back
// onto the page grid without losing position metadata.

/**
 * App bar. Renders as a horizontal strip across the top of its grid
 * cell (typically `col=1, colSpan=48, row=1, rowSpan=4` for a
 * full-width top bar). Children stack as a flex row with consistent
 * spacing + theme styling, so an author can drop logo + title +
 * search + user menu into it and they look like one cohesive bar
 * rather than five separate widget boxes.
 *
 * Why a dedicated kind rather than a generic flex container: the
 * app-bar imposes opinionated chrome (single-row layout, fixed
 * height, sticky / non-sticky behavior, theme-driven background
 * blur) that authors don't have to think about. Drop a widget in,
 * it looks right.
 */
export interface AppBarWidgetConfig {
  kind: 'app-bar';
  /** Child widgets rendered as a flex row inside the bar. */
  widgets: CustomWidget[];
  /**
   * Optional logo image rendered at the left of the bar before the
   * first child. The portal's branding logo when omitted (matches
   * the portal chrome's logo treatment, so apps stay on-brand
   * without authors having to upload).
   */
  logoUrl?: string;
  /**
   * Title rendered next to the logo. Falls back to the item's own
   * title when omitted, so most authors don't have to set this.
   */
  title?: string;
  /** Optional subtitle / tagline below the title. */
  subtitle?: string;
  /**
   * When true (the default), the bar stays anchored to the top of
   * the runtime viewport even as the page scrolls. Authors who want
   * a hero-style scroll-away bar set this to false.
   */
  sticky?: boolean;
  /**
   * Visual variant for the bar's chrome. 'elevated' is the default
   * (subtle shadow, solid surface); 'glass' is a translucent /
   * blurred bar for map-first layouts; 'flat' is a borderless flush
   * bar for minimal themes.
   */
  variant?: 'elevated' | 'glass' | 'flat';
}

/**
 * Dock panel. Renders as a fixed-width column along the left or
 * right edge of its grid cell (typically `colSpan=8, rowSpan=full`
 * for a left dock). Children stack vertically; the container
 * handles spacing, dividers between sibling widgets, and the
 * collapse-to-rail affordance.
 *
 * The dock can be either always-open (the default; takes space on
 * the page) or collapsible-to-rail (the panel shrinks to a 40px
 * icon rail when collapsed and expands on click). The rail icons
 * come from each child widget's per-kind icon registry.
 */
export interface DockPanelWidgetConfig {
  kind: 'dock-panel';
  /** Side of the parent the dock attaches to. Determines collapse-
   *  to-rail direction and inner divider styling. */
  side: 'left' | 'right';
  /** Child widgets rendered as a flex column inside the dock. */
  widgets: CustomWidget[];
  /** Header label shown at the top of the dock. */
  title?: string;
  /**
   * When true, the dock shows a collapse handle at the top; clicking
   * shrinks the dock to a narrow icon rail. Children fold into
   * their kind-specific icon. Defaults to true for left docks (room
   * to spare for the map) and true for right docks (consistency).
   */
  collapsible?: boolean;
  /**
   * Initial collapsed state. The runtime tracks live state from
   * here; the author's pick is the default that ships with the app.
   */
  defaultCollapsed?: boolean;
  /** Width in CSS px when open. Default 280. */
  widthPx?: number;
}

/**
 * Slideout drawer. Hidden by default; opens via a trigger button
 * the slideout itself stamps at the edge of the runtime container.
 * Used for "tools" drawers that the author doesn't want to take
 * permanent space.
 */
export interface SlideoutWidgetConfig {
  kind: 'slideout';
  /** Edge the drawer slides in from. */
  edge: 'left' | 'right' | 'top' | 'bottom';
  /** Child widgets stacked inside the drawer. */
  widgets: CustomWidget[];
  /** Trigger button label. Visible at the edge of the runtime when
   *  the drawer is closed; clicking opens. Defaults to "Tools". */
  triggerLabel?: string;
  /** Icon hint for the trigger. Falls back to a default per edge. */
  triggerIcon?: 'menu' | 'layers' | 'tools' | 'filter';
  /** Width (left/right edges) or height (top/bottom) in CSS px when
   *  open. Default 320. */
  sizePx?: number;
}

/**
 * Foldable group. A simple container with a header + chevron that
 * collapses / expands a stack of child widgets. Use for grouping
 * related controls into a labeled accordion section (Layers +
 * Legend together under "Layers"; Bookmark + Coordinates together
 * under "Navigation").
 *
 * Authors typically nest these inside a dock-panel or a slideout so
 * a deep tool tree fits in a small side dock.
 */
export interface FoldableGroupWidgetConfig {
  kind: 'foldable-group';
  /** Header label rendered with the chevron. */
  title: string;
  /** Optional secondary text under the title. */
  subtitle?: string;
  /** Child widgets stacked inside when expanded. */
  widgets: CustomWidget[];
  /** Initial open state. Defaults to true. */
  defaultOpen?: boolean;
}

/**
 * Freshly-created Custom Web App. One blank page with no widgets;
 * the designer prompts the author to drop a widget on first open.
 */
export const DEFAULT_CUSTOM_APP: CustomAppData = {
  version: 3,
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
 * Migrate a CustomAppData to the latest schema version. Each bump
 * doubles every widget layout coordinate so the same physical layout
 * round-trips through a finer designer grid: v1 (12 col / 48px row)
 * -> v2 (24 col / 24px row) -> v3 (48 col / 12px row). v3 was driven
 * by user feedback that the toolbar-button snap was too coarse.
 *
 * Idempotent: calling on an already-current app is a no-op. Chain
 * upgrades (a v1 app gets v1->v2 then v2->v3 on load). Caller should
 * persist the result back to the item on the next save (the
 * designer's setApp(initial) flow handles that automatically).
 *
 * Recurses through Tabs widgets (#362) so nested children also pick
 * up the new grid coordinates.
 */
export function migrateCustomAppData(data: CustomAppData): CustomAppData {
  let cur = data;
  if (cur.version === 1) {
    cur = {
      ...cur,
      version: 2,
      pages: cur.pages.map((p) => ({
        ...p,
        widgets: p.widgets.map(migrateWidgetDoubleLayout),
      })),
    };
  }
  if (cur.version === 2) {
    cur = {
      ...cur,
      version: 3,
      pages: cur.pages.map((p) => ({
        ...p,
        widgets: p.widgets.map(migrateWidgetDoubleLayout),
      })),
    };
  }
  return cur;
}

/**
 * Double every layout coordinate. Used for both the v1->v2 and the
 * v2->v3 jump: each grid bump doubled both the column count and the
 * row resolution, so the same multiplier preserves the visual layout
 * across versions.
 */
function migrateWidgetDoubleLayout(w: CustomWidget): CustomWidget {
  const next: CustomWidget = {
    ...w,
    layout: {
      col: ((w.layout.col - 1) * 2) + 1,
      row: ((w.layout.row - 1) * 2) + 1,
      colSpan: w.layout.colSpan * 2,
      rowSpan: w.layout.rowSpan * 2,
    },
  };
  if (w.kind === 'tabs' && w.config.kind === 'tabs') {
    next.config = {
      ...w.config,
      tabs: w.config.tabs.map((t) => ({
        ...t,
        widgets: t.widgets.map(migrateWidgetDoubleLayout),
      })),
    };
  }
  return next;
}
