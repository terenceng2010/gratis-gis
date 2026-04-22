/**
 * Canonical shape stored in an Item's dataJson when `type = 'web_map'`.
 *
 * Versioned for forward compatibility: when we need a breaking change to
 * layer structure, bump the `version` field and write a migrator. The
 * viewer is expected to tolerate missing fields and fall back to
 * defaults so older maps keep rendering after additive changes.
 */
export type BasemapKey =
  | 'osm'
  | 'positron'
  | 'dark-matter'
  | 'voyager'
  | 'satellite';

export interface WebMapData {
  version: 1;
  basemap: BasemapKey;
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  layers: WebMapLayer[];
  search: WebMapSearchConfig;
}

/**
 * Map-level search settings. Per-layer attribute search is configured
 * on each WebMapLayer; this controls how address geocoding works and
 * whether the search bar shows up at all.
 */
export interface WebMapSearchConfig {
  /** Whether the search bar is visible on the map. Default on. */
  enabled: boolean;
  /**
   * Whether to geocode free-text queries via a third-party service
   * (Nominatim by default). Some orgs prefer keeping searches local
   * to their own data and will turn this off.
   */
  geocoding: boolean;
}

export interface WebMapLayer {
  id: string;
  title: string;
  visible: boolean;
  /** 0-1 multiplier applied to all paint fill / stroke / circle alpha. */
  opacity: number;
  source: WebMapLayerSource;
  style: WebMapLayerStyle;
  /**
   * How to color features: one color for everything, or one color per
   * distinct value of an attribute. `null` means use the simple style
   * colors as-is.
   */
  renderer: WebMapLayerRenderer;
  popup: WebMapLayerPopup;
  interactions: WebMapLayerInteractions;
  labels: WebMapLayerLabels;
  search: WebMapLayerSearch;
  /**
   * Optional single-clause attribute filter. Null means "show every
   * feature". A multi-clause boolean builder can land later; one
   * clause covers most real-world filtering needs and keeps the
   * editor small.
   */
  filter: WebMapLayerFilter | null;
}

/**
 * Rendering strategies.
 *
 * - `simple`: use the colors in `WebMapLayerStyle` for every feature.
 * - `unique-values`: pick a color per distinct value of `field` from
 *   `categories`; fall back to the simple color for anything not in
 *   the list.
 * - `class-breaks`: map a numeric field to colors by bucket. `stops`
 *   are ascending threshold values; `colors` has exactly
 *   `stops.length + 1` entries, the first for input < stops[0], the
 *   last for input >= stops[stops.length - 1].
 */
export type WebMapLayerRenderer =
  | { kind: 'simple' }
  | {
      kind: 'unique-values';
      field: string;
      categories: WebMapUniqueValueCategory[];
    }
  | {
      kind: 'class-breaks';
      field: string;
      stops: number[];
      colors: string[];
    };

export interface WebMapUniqueValueCategory {
  /** Distinct value of the field, coerced to string. */
  value: string;
  color: string;
}

export type WebMapFilterOp =
  | '=='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'contains'
  | 'is-null'
  | 'is-not-null';

/**
 * A single where-clause. Stays string-typed so the editor stores a
 * stable shape; the viewer coerces numeric comparisons at render time.
 */
export interface WebMapLayerFilterClause {
  field: string;
  op: WebMapFilterOp;
  /** Unused for is-null / is-not-null. */
  value: string;
}

/**
 * Multi-clause filter. `combinator: 'all'` is AND (every clause must
 * match), `any` is OR (at least one). A single-clause filter is just a
 * WebMapLayerFilter with one entry; multi-clause boolean trees (nested
 * AND/OR) can land later if real workloads ask for them.
 */
export interface WebMapLayerFilter {
  combinator: 'all' | 'any';
  clauses: WebMapLayerFilterClause[];
}

/**
 * Layer data sources. `geojson-url` pulls from a public URL at load
 * time; `geojson-inline` stores the GeoJSON body directly in the item
 * (small datasets only, it lives in dataJson); `feature-service`
 * references a portal item and will light up once that pillar ships.
 */
export type WebMapLayerSource =
  | { kind: 'geojson-url'; url: string }
  | { kind: 'geojson-inline'; geojson: unknown }
  | { kind: 'feature-service'; itemId: string };

/**
 * Simple-renderer style vocabulary, one section per geometry family.
 * A MapLibre layer is added per applicable family for a source, so a
 * mixed GeoJSON collection renders points + lines + polygons together.
 *
 * Colors are CSS / hex strings, rendered via MapLibre paint properties.
 */
/**
 * Which marker shape a point layer renders. `circle` keeps the
 * classic dot; `icon` swaps in a named symbol registered with
 * MapLibre via the map-icons library. Additional kinds (e.g. custom
 * uploaded SVG) slot in here.
 */
export type PointSymbol = 'circle' | 'icon';

export interface WebMapLayerStyle {
  point: {
    color: string;
    radius: number;
    strokeColor: string;
    strokeWidth: number;
    /**
     * Marker shape. `circle` (the default) uses color + radius +
     * outline; `icon` uses a pre-registered SVG referenced by name.
     */
    symbol: PointSymbol;
    /**
     * Required when symbol is `icon`. Names a built-in icon from the
     * MAP_ICONS registry (e.g. `"map-pin"`). Blank when using circle.
     */
    iconName: string;
    /** Multiplier applied to the icon's base 48px size. */
    iconSize: number;
    /**
     * When true, the icon renders via its SDF variant and is tinted
     * by `color`. When false, the icon uses its shipped colors as-
     * rendered from the SVG. Always off for raster uploads (PNG /
     * JPEG / etc.) since those can't be meaningfully SDF-encoded.
     */
    iconTint: boolean;
  };
  line: {
    color: string;
    width: number;
  };
  polygon: {
    fillColor: string;
    fillOpacity: number;
    strokeColor: string;
    strokeWidth: number;
  };
}

/**
 * Popup configuration. `enabled: false` disables click popups for this
 * layer entirely.
 *
 * `mode` picks how the body is rendered:
 *   - `all`: show every property on the feature (the default — zero-
 *     config for "just give me a popup").
 *   - `picked`: only show fields in `fields`, in that exact order.
 *   - `template`: render `bodyTemplate` as a Handlebars-lite string.
 *     Supports `{{field}}` interpolation and pipe-style formatters
 *     (`{{field | upper}}`, `{{date | date}}`, `{{n | number}}`,
 *     `{{v | currency}}`). HTML in the template is rendered as-is so
 *     authors can write small markup; values are always HTML-escaped.
 *
 * `titleTemplate` is an optional {{field}}-style string used for the
 * popup header. Empty falls back to the layer's own title.
 */
export interface WebMapLayerPopup {
  enabled: boolean;
  mode: 'all' | 'picked' | 'template';
  fields: string[];
  titleTemplate: string;
  bodyTemplate: string;
}

/**
 * Per-layer interaction toggles. `hoverHighlight` swaps to a lighter
 * paint while the cursor is over a feature. `editingEnabled` is a
 * forward-compatibility hint; editing UI only attaches to layers whose
 * source supports writes (feature-service, once it ships).
 */
export interface WebMapLayerInteractions {
  hoverHighlight: boolean;
  editingEnabled: boolean;
  /**
   * When true (the default), features on this layer can be picked via
   * the attribute table checkboxes, map click/rectangle/lasso/polygon
   * tools, and programmatic selection. When false, the layer is
   * effectively read-only for selection purposes — useful for
   * basemap-style overlays that shouldn't compete for attention.
   */
  selectable: boolean;
}

/**
 * Per-layer search configuration consumed by the map's search bar.
 * When `enabled` is true and `fields` is non-empty, the search bar
 * walks this layer's feature collection and emits results that match
 * a substring query against any of the listed fields.
 *
 * `labelTemplate` follows the same {{field}}-with-formatter grammar as
 * popups; empty means "use the first matching field's value".
 */
export interface WebMapLayerSearch {
  enabled: boolean;
  fields: string[];
  labelTemplate: string;
}

/**
 * Per-layer text labels. Renders as a MapLibre `symbol` layer on top
 * of the geometry. `placement: 'auto'` uses point-anchored labels for
 * points and polygons (centered), and follows the geometry for lines.
 *
 * `template` is a Handlebars-lite string with `{{field}}` interpolation
 * and optional `| formatter` pipes (`upper`, `lower`, `number`,
 * `currency`, `date`). Static text around tokens renders verbatim, so
 * `"Population: {{pop | number}}"` works as expected.
 *
 * `offsetX` / `offsetY` are in em (multiples of the text size) and are
 * handed straight to MapLibre's `text-offset` layout property. Positive
 * Y is *down* on screen; positive X is right. Typical usage is a small
 * positive Y to push a label below a point marker.
 */
export interface WebMapLayerLabels {
  enabled: boolean;
  /**
   * Handlebars-lite text expression. Empty string means "no label even
   * though enabled is true" (the renderer skips the symbol layer).
   */
  template: string;
  size: number;
  color: string;
  haloColor: string;
  haloWidth: number;
  placement: 'auto' | 'line';
  anchor: 'center' | 'top' | 'bottom' | 'left' | 'right';
  offsetX: number;
  offsetY: number;
}

/** Freshly-created map with the defaults we want every new map to carry. */
export const DEFAULT_WEB_MAP: WebMapData = {
  version: 1,
  basemap: 'positron',
  center: [-98.5795, 39.8283],
  zoom: 3,
  bearing: 0,
  pitch: 0,
  layers: [],
  search: {
    enabled: true,
    geocoding: true,
  },
};

/** Default paint for a fresh layer. Accent-adjacent so it's visible on any basemap. */
export const DEFAULT_LAYER_STYLE: WebMapLayerStyle = {
  point: {
    color: '#6366f1',
    radius: 6,
    strokeColor: '#ffffff',
    strokeWidth: 1.5,
    symbol: 'circle',
    iconName: '',
    iconSize: 1,
    iconTint: true,
  },
  line: {
    color: '#6366f1',
    width: 2,
  },
  polygon: {
    fillColor: '#6366f1',
    fillOpacity: 0.25,
    strokeColor: '#4338ca',
    strokeWidth: 1.5,
  },
};

export const DEFAULT_LAYER_POPUP: WebMapLayerPopup = {
  enabled: true,
  mode: 'all',
  fields: [],
  titleTemplate: '',
  bodyTemplate: '',
};

export const DEFAULT_LAYER_INTERACTIONS: WebMapLayerInteractions = {
  hoverHighlight: true,
  editingEnabled: false,
  selectable: true,
};

export const DEFAULT_LAYER_SEARCH: WebMapLayerSearch = {
  enabled: false,
  fields: [],
  labelTemplate: '',
};

export const DEFAULT_LAYER_LABELS: WebMapLayerLabels = {
  enabled: false,
  template: '',
  size: 12,
  color: '#111827',
  haloColor: '#ffffff',
  haloWidth: 1.5,
  placement: 'auto',
  anchor: 'top',
  offsetX: 0,
  offsetY: 1.1,
};

export const DEFAULT_LAYER_RENDERER: WebMapLayerRenderer = { kind: 'simple' };

/**
 * Palette used to auto-assign colors to unique-value categories. Chosen
 * to be colorblind-aware (Okabe–Ito–style distinctness) and to sit well
 * on both light and dark basemaps. Extend by appending; existing
 * categories keep the color that was picked at creation time.
 */
export const UNIQUE_VALUE_PALETTE: string[] = [
  '#0ea5e9',
  '#f97316',
  '#8b5cf6',
  '#10b981',
  '#ef4444',
  '#f59e0b',
  '#ec4899',
  '#14b8a6',
  '#6366f1',
  '#84cc16',
  '#06b6d4',
  '#d946ef',
];

/**
 * Sequential and diverging ramps for class-breaks rendering. Each ramp
 * is an ordered list of colors; the renderer picks as many as there are
 * classes via `sampleRamp`. Chosen for readability on typical basemaps;
 * more can be added without breaking persisted maps.
 */
export const CLASS_BREAK_RAMPS: Record<string, string[]> = {
  Blues: ['#eff6ff', '#bfdbfe', '#60a5fa', '#2563eb', '#1e3a8a'],
  Greens: ['#f0fdf4', '#bbf7d0', '#4ade80', '#16a34a', '#14532d'],
  Oranges: ['#fff7ed', '#fed7aa', '#fb923c', '#ea580c', '#7c2d12'],
  Reds: ['#fef2f2', '#fecaca', '#f87171', '#dc2626', '#7f1d1d'],
  Viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  Spectral: ['#3288bd', '#99d594', '#e6f598', '#fdae61', '#d53e4f'],
};

export const DEFAULT_CLASS_BREAK_RAMP = 'Viridis';

/**
 * Linearly sample a ramp down to exactly `n` colors. If `n` matches the
 * ramp length we return it verbatim; otherwise pick evenly-spaced
 * entries. Guarantees the first and last ramp colors are preserved so
 * the extremes are visually stable as the class count changes.
 */
export function sampleRamp(ramp: string[], n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [ramp[Math.floor(ramp.length / 2)]!];
  if (ramp.length === n) return [...ramp];
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    const idx = Math.round(t * (ramp.length - 1));
    out.push(ramp[idx]!);
  }
  return out;
}
