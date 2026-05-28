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
 * v1 actions are URL-shaped on purpose. "Navigate the user to
 * somewhere" covers a lot of "show me the thing" workflows and
 * needs no execution backend.
 *
 * v2 adds the `recipe` action kind: a parameterized on-demand action
 * that reuses the derived_layer ToolStep vocabulary.  Authors define
 * named parameter slots (an AOI, a target layer, a predicate, a
 * distance) with binding modes (hardcoded, resolved from the host
 * app, drawn at runtime, picked at runtime).  At run time the recipe
 * runner resolves the parameters, substitutes them into the pipeline,
 * compiles to PostGIS, and either updates the host app's selection or
 * creates a derived_layer / data_layer item from the result.
 *
 * See docs/tool-items-v2.md for the full design.
 */

import type { LengthUnit } from './length';
import type {
  SpatialPredicate,
  ToolStep,
} from './derived-layer';

/**
 * What the tool does when triggered.  Discriminated on `kind`.
 *
 * The first three are v1 navigation/export shapes.  `recipe` is the
 * v2 parameterized-action shape; it carries its own sub-schema for
 * parameters + pipeline + output.
 */
export type ToolAction =
  | OpenItemAction
  | OpenUrlAction
  | ExportLayerAction
  | RecipeAction
  | OsmRelationalQueryAction;

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
 * Export a data_layer sublayer to CSV or XLSX.  Same client-side
 * code path the Export widget uses (#110), reachable from a
 * Button widget bound to a tool.  Letting an export live as a
 * reusable tool means an org with five apps that all need
 * "download the parcels" can author the tool once and point five
 * buttons at it -- update the format / scope in one place.
 */
export interface ExportLayerAction {
  kind: 'export-layer';
  /** data_layer item id whose features to export. */
  targetItemId: string;
  /** Sublayer key inside the data_layer.  Required because v3
   *  data_layer items are multi-layer; the tool authors pick a
   *  specific sublayer rather than dumping every one. */
  layerKey: string;
  /** Output format. */
  format: 'csv' | 'xlsx';
}

// ---- Recipe action (v2) ----------------------------------------------------

/**
 * Geometry types accepted by a feature-source parameter.  `'any'`
 * relaxes the constraint -- some tools (e.g. Select By Location)
 * work on a point, line, or polygon AOI interchangeably.
 */
export type ParameterGeometryType = 'point' | 'line' | 'polygon' | 'any';

/**
 * Reference to a feature source used as a parameter value.  Used
 * both as a hardcoded binding default and as the run-time payload
 * shape when the binding is `runtime-host` or `runtime-selection`.
 */
export interface FeatureSourceValue {
  /**
   * `data_layer`: the source is a portal data_layer (the typical
   *               case for layers the host app already maps).
   * `derived_layer`: the source is a portal derived_layer.
   * `inline-geojson`: the source is an inline GeoJSON Feature or
   *               FeatureCollection supplied at run time (used by
   *               `runtime-draw` parameters).
   */
  kind: 'data_layer' | 'derived_layer' | 'inline-geojson';
  /** Layer item id; absent for `inline-geojson`. */
  itemId?: string;
  /** Sublayer key for v3 multi-layer data_layers. */
  layerKey?: string;
  /** Inline GeoJSON for `inline-geojson`. */
  geojson?: unknown;
  /** Optional subset of feature ids to constrain the source to. */
  featureIds?: Array<string | number>;
}

/**
 * Feature-source parameter -- typically the AOI, a target layer, or
 * a "filter by" layer for a spatial-filter step.
 *
 * Binding modes:
 *   - `hardcoded`:        the layer is baked into the tool.  Use when
 *                         the tool is meant to operate against one
 *                         specific layer (e.g. "Find addresses inside
 *                         the OSM buildings layer").
 *   - `runtime-host`:     resolved from the host app's available
 *                         layers at run time.  The Button widget can
 *                         pre-bind this to a specific layer; if
 *                         unbound, the runtime parameter UI prompts.
 *   - `runtime-draw`:     user draws a geometry interactively at run
 *                         time (point, line, polygon).
 *   - `runtime-selection`: use the current host map selection as the
 *                         feature source.
 */
export interface FeatureSourceParameter {
  kind: 'feature-source';
  /** Slot name; referenced from step params as `{ kind: 'parameter', name }`. */
  name: string;
  /** Human label shown in the runtime UI and the tool designer. */
  label: string;
  /** Optional short blurb shown under the label. */
  hint?: string;
  /** Whether the parameter must be resolved before the tool can run. */
  required?: boolean;
  /** Geometry type constraint.  Defaults to 'any'. */
  geometryType?: ParameterGeometryType;
  binding:
    | { mode: 'hardcoded'; value: FeatureSourceValue }
    | { mode: 'runtime-host'; defaultValue?: FeatureSourceValue }
    | { mode: 'runtime-draw' }
    | { mode: 'runtime-selection' };
}

/**
 * Predicate parameter -- usually drives a spatial-filter step.
 *
 * Binding modes:
 *   - `hardcoded`: the predicate is baked into the tool.
 *   - `runtime-pick`: end-user picks at run time (with optional
 *                     `allowed` set narrowing the chip strip).
 */
export interface PredicateParameter {
  kind: 'predicate';
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  binding:
    | { mode: 'hardcoded'; value: SpatialPredicate }
    | {
        mode: 'runtime-pick';
        defaultValue: SpatialPredicate;
        /** Subset of predicates the runtime picker exposes; omitted
         *  means all of them. */
        allowed?: SpatialPredicate[];
      };
}

/**
 * Distance parameter, always in meters internally.  Wizard surfaces
 * a unit toggle; the saved value normalises to meters.
 *
 * Binding modes:
 *   - `hardcoded`: fixed meters value.
 *   - `runtime-input`: user types a number at run time.
 */
export interface DistanceParameter {
  kind: 'distance';
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  /**
   * Display unit for the user-facing input.  Storage is always
   * meters (so the recipe runner doesn't have to think about
   * units); this field controls only how the author + end-user
   * SEE the distance in the parameter editor + runtime panel.
   * Defaults to `meters` when omitted, preserving the v1 shape.
   * The runtime panel still lets the end-user pick a different
   * unit per run from a small dropdown next to the number input.
   */
  unit?: LengthUnit;
  binding:
    | { mode: 'hardcoded'; meters: number }
    | {
        mode: 'runtime-input';
        defaultMeters: number;
        minMeters?: number;
        maxMeters?: number;
      };
}

/** Plain-number parameter (no unit semantics). */
export interface NumberParameter {
  kind: 'number';
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  binding:
    | { mode: 'hardcoded'; value: number }
    | {
        mode: 'runtime-input';
        defaultValue: number;
        min?: number;
        max?: number;
      };
}

/** Free-text parameter -- e.g. a SQL where-clause snippet or a title. */
export interface TextParameter {
  kind: 'text';
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  binding:
    | { mode: 'hardcoded'; value: string }
    | { mode: 'runtime-input'; defaultValue?: string };
}

/**
 * Single lat/lon point parameter (#150 / #152).  Underpins tools
 * that ask the user to "drop a pin": Nearest N, Reverse geocode,
 * future bearing / route-from-point queries.  Coordinates are
 * WGS-84 (EPSG:4326) decimal degrees; the runtime UI shows a
 * "drop pin on map" button as the primary affordance and a
 * lat/lon input pair as a fallback so a user with a coordinate
 * in hand can paste it directly.
 *
 *   - `hardcoded`:    the tool is dedicated to one fixed point
 *                     (e.g. "Find every coffee shop near our HQ").
 *                     The runtime UI doesn't show a row; the
 *                     baked-in point ships with the request.
 *   - `runtime-pick`: the user drops a pin (or types coordinates)
 *                     at runtime.  Optional defaults seed the
 *                     initial value so a tool can preselect a
 *                     sensible starting point (e.g. the map's
 *                     current center) without forcing it.
 */
export interface PointParameter {
  kind: 'point';
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  binding:
    | { mode: 'hardcoded'; lng: number; lat: number }
    | {
        mode: 'runtime-pick';
        /** Optional preselect; the runtime UI seeds the inputs
         *  with these so the user can click Run immediately if the
         *  default is what they wanted.  Either both or neither
         *  should be set; a half-default is treated as "no
         *  default" by the runtime. */
        defaultLng?: number;
        defaultLat?: number;
      };
}

/**
 * Tag filter on an OSM query.  v1 supports literal-equals matches
 * only; contains / regex are queued for wave 3 once we have a
 * frequency-weighted autocomplete catalog to make them useful.
 */
export interface OsmTagFilter {
  key: string;
  value: string;
  op?: 'equals' | 'contains' | 'regex';
}

/**
 * OpenStreetMap feature parameter (#OSM).
 *
 * Lets a recipe consume OSM data on demand: at run time the recipe
 * runner builds an Overpass query from the parameter's preset ids +
 * tag filters, hits the configured Overpass endpoint, converts the
 * result to GeoJSON, and writes it into a transient observation-log
 * scope so downstream steps (spatial-filter, spatial-join) can read
 * it like any other source.
 *
 * The author chooses one of two binding modes:
 *
 *   - `hardcoded`:    the tool is dedicated to one specific OSM
 *                     lookup ("Find pharmacies near my facility").
 *                     User just provides AOI + distance at runtime.
 *   - `runtime-pick`: the user picks at runtime which presets to
 *                     query and (optionally) what tag filters to
 *                     add.  This is the flexible guided-query mode
 *                     that powers "Show me Citgo gas stations within
 *                     1 mile of my parcel": the user multi-selects
 *                     "Gas stations" + types `brand=Citgo`.
 *
 * For `runtime-pick` the author can narrow what the user sees via
 * an `allowedCategories` whitelist (e.g. only let users pick from
 * `amenity` + `shop` categories), an `allowedPresetIds` explicit
 * subset, and an `allowCustomTagFilters` switch (off when the
 * author wants a strictly guided experience with no free-text
 * filters).  Empty / omitted means "any preset / any filter".
 */
export interface OsmFeatureParameter {
  kind: 'osm-feature';
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  /**
   * #101: per-recipe Overpass cache TTL in minutes. Caller-visible
   * shape: 0 means "always fresh" (skip the cache), unset means
   * "use the engine default" (currently 1 hour), and a number means
   * "use the cache for this many minutes." The recipe runner clamps
   * this to a sane upper bound so a typo can't permanently pin
   * stale data.
   */
  ttlMinutes?: number;
  binding:
    | {
        mode: 'hardcoded';
        /** One or more preset ids from the catalog; queries are a
         *  union across all of them. */
        presetIds: string[];
        tagFilters?: OsmTagFilter[];
      }
    | {
        mode: 'runtime-pick';
        defaultPresetIds?: string[];
        defaultTagFilters?: OsmTagFilter[];
        /** Top-level OSM tag-key categories the picker is allowed
         *  to surface (e.g. ['amenity', 'shop']).  Empty / omitted
         *  means no restriction. */
        allowedCategories?: string[];
        /** Explicit subset of preset ids the picker may surface.
         *  Empty / omitted means no restriction. */
        allowedPresetIds?: string[];
        /** When false, the runtime tag-filter editor is hidden;
         *  the user can only choose presets.  Defaults to true. */
        allowCustomTagFilters?: boolean;
      };
}

/**
 * Discriminated union of every tool-recipe parameter kind.  Adding a
 * new parameter kind means extending the union, the runtime UI's
 * prompt switch, and the recipe runner's substitution map.
 */
export type ToolParameter =
  | FeatureSourceParameter
  | PredicateParameter
  | DistanceParameter
  | NumberParameter
  | TextParameter
  | OsmFeatureParameter
  | PointParameter;

/**
 * What happens with the pipeline's output when the tool finishes.
 *
 *   - `selection`:           update the host app's selection state on
 *                            the layer referenced by
 *                            `targetParameterRef` to the set of
 *                            feature ids produced by the pipeline.
 *                            No new persistent item is created.
 *   - `osm-features-overlay`: render the pipeline output as a
 *                            transient overlay on the host map(s),
 *                            with ODbL attribution baked in.  The
 *                            user gets a "Save as data layer" button
 *                            to materialise the overlay into a real
 *                            data_layer when they want to keep it.
 *                            Output features are not associated with
 *                            any pre-existing layer.
 *   - `derived-layer`:       create (or upsert) a derived_layer item
 *                            whose recipe is the resolved pipeline.
 *                            Live lens that recomputes on every
 *                            read.  Deferred to wave 2.
 *   - `data-layer`:          materialise the result into a new v3
 *                            data_layer item -- a snapshot, not a
 *                            lens.  Deferred to wave 2+.
 */
export type ToolOutput =
  | { kind: 'selection'; targetParameterRef: string }
  | { kind: 'osm-features-overlay' }
  | { kind: 'derived-layer'; titleTemplate: string }
  | { kind: 'data-layer'; titleTemplate: string };

/**
 * The v2 recipe action.  Carries everything the runner needs to
 * resolve a tool invocation: the parameter schema, the pipeline that
 * consumes them, and the output sink.
 *
 * Steps inside `pipeline` may reference parameters via
 * `{ kind: 'parameter', name: '<paramName>' }` shapes in their
 * source / predicate / distance fields.  The recipe runner walks the
 * pipeline at run time and replaces each parameter reference with the
 * resolved value before handing the (now derived_layer-shaped)
 * pipeline to the existing SQL compiler.
 */
export interface RecipeAction {
  kind: 'recipe';
  /** Schema version inside the recipe action; bumped on incompat. */
  recipeVersion: 1;
  parameters: ToolParameter[];
  pipeline: ToolStep[];
  output: ToolOutput;
  /**
   * Parameter ref that provides the pipeline's input rows.  When
   * omitted, defaults to `output.targetParameterRef` for selection
   * output (preserving the v1 behaviour).  Must be set for output
   * sinks where the "source layer" isn't on the output:
   *
   *   - `osm-features-overlay`: point at the osm-feature parameter
   *     whose query the pipeline filters / annotates.
   *   - `derived-layer` / `data-layer` (future): the parameter
   *     whose data is the recipe's input.
   *
   * Valid parameter kinds:
   *   - `feature-source`: pipeline reads from a data_layer (current
   *     behaviour for selection output).
   *   - `osm-feature`: pipeline reads from the OSM-feature
   *     parameter's transient scope materialised by the recipe
   *     runner.
   */
  sourceParameterRef?: string;
  /**
   * For OSM-driven output sinks: the parameter whose resolved
   * geometry provides the area of interest.  The recipe runner
   * uses its bbox (padded by any distance step in the pipeline) to
   * bound the Overpass call so we don't fetch the whole continent
   * when the user only cares about features near their parcel.
   *
   * Required when `output.kind === 'osm-features-overlay'` and the
   * pipeline references an osm-feature parameter; ignored
   * otherwise.
   */
  aoiParameterRef?: string;
  /**
   * Hard cap on rows returned for `output.kind === 'selection'`. The
   * runtime warns the user when truncation occurs.  Mirrors the
   * features-page cap so big-data layers degrade gracefully rather
   * than freezing the browser.
   */
  selectionLimit?: number;
}

/**
 * Stored data shape for a `tool` item.  Item core fields (id,
 * title, description, owner, sharing) live on the item table; this
 * is the `data` blob.
 */
export interface ToolItemData {
  /** Schema version.  Bumped whenever the data shape changes
   *  incompatibly so the runtime can refuse stale tool configs
   *  cleanly.  v1 only had navigation actions; v2 added the recipe
   *  action kind.  Existing v1 tools deserialize fine under v2
   *  because v2 is purely additive at the union level. */
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

/**
 * Default selection cap for recipe runs.  Mirrors features-page so
 * the parcel-style "1.4M rows" case can't melt the browser.  The
 * recipe runner reports `truncated: true` when the cap is reached.
 */
export const DEFAULT_TOOL_SELECTION_LIMIT = 5000;

/**
 * Returns a freshly-stubbed recipe action.  Used by the tool
 * designer when the author switches the action kind to "recipe" and
 * by the "new tool from template" path when seeding a starter.
 *
 * The default is intentionally empty:
 *   - no parameters
 *   - no pipeline
 *   - selection output bound to no parameter (invalid until the
 *     author wires one up)
 *
 * The designer prompts the author to fill these in; the save-time
 * validator rejects an empty pipeline so a half-finished recipe
 * doesn't silently no-op at runtime.
 */
export function emptyRecipeAction(): RecipeAction {
  return {
    kind: 'recipe',
    recipeVersion: 1,
    parameters: [],
    pipeline: [],
    output: { kind: 'selection', targetParameterRef: '' },
    selectionLimit: DEFAULT_TOOL_SELECTION_LIMIT,
  };
}

/** Type guard for the recipe action kind.  Useful where we need to
 *  branch on action without exhaustive switches. */
export function isRecipeAction(action: ToolAction): action is RecipeAction {
  return action.kind === 'recipe';
}

/**
 * Distance value + unit pair used by the relational query (and any
 * future surface that needs the same shape).  Mirrors the runtime
 * distance picker so the user's "0.5 mi" travels through the action
 * payload without intermediate normalisation.  The recipe runner is
 * the canonical converter to meters.
 */
export interface RelationalDistance {
  value: number;
  unit: 'm' | 'km' | 'ft' | 'mi';
}

/**
 * Relational OSM query: find every feature of `anchorPreset` that
 * sits within distance D_i of at least one feature of each
 * `conditions[i].preset`, all inside the resolved AOI.  The classic
 * use case is "find me every school within 0.5 miles of a park AND
 * within 0.5 miles of a liquor store" - shippable as a single tool
 * the user can re-run per neighbourhood.
 *
 * v1 is AND-only across conditions and skips per-condition tag
 * filters; both are tracked as follow-ups so the schema stays
 * narrow while we ship the dominant case.  See the spec on issue
 * #142 for the full design.
 */
export interface OsmRelationalQueryAction {
  kind: 'osm-relational-query';
  /** Schema version inside the action.  Bumped on incompat. */
  relationalVersion: 1;
  /**
   * Preset id from the iD preset catalog (e.g. 'amenity/school').
   * Every matching feature returned by Overpass is a candidate; the
   * relational predicates below filter it down to the survivors.
   */
  anchorPreset: string;
  /**
   * Optional anchor result cap.  Forwarded to the Overpass call so
   * a runaway AOI doesn't try to return 50k schools.  Defaults to
   * the engine's `DEFAULT_OSM_MAX_FEATURES`.
   */
  anchorMaxResults?: number;
  /**
   * Conditions every surviving anchor must satisfy.  v1 is
   * AND-only: an anchor is kept iff at least one feature of each
   * condition's preset lies within `condition.distance` of it.
   * Empty list = "every anchor inside the AOI" (degenerate; the
   * caller probably wants a plain OSM query instead).
   */
  conditions: Array<{
    preset: string;
    distance: RelationalDistance;
  }>;
  /**
   * Reserved for the eventual OR / mixed-operator extension.  v1
   * accepts only 'and' and ignores anything else.  Kept on the wire
   * so existing tools deserialise cleanly when OR ships.
   */
  combinator?: 'and';
  /**
   * Per-recipe Overpass cache TTL override in minutes.  Same
   * semantics as OsmFeatureParameter.ttlMinutes: 0 means
   * "always fresh", unset means "engine default", >0 means
   * "cache for this many minutes" (clamped server-side).
   */
  ttlMinutes?: number;
  /**
   * Runtime parameters the user fills in.  v1 needs exactly one
   * FeatureSourceParameter (the AOI); future versions can let the
   * user pick anchor / condition presets at runtime by promoting
   * those fields to runtime parameters.
   */
  parameters: ToolParameter[];
  /**
   * Name of the FeatureSourceParameter that provides the area of
   * interest.  The runner pads its bbox by the largest condition
   * distance before the Overpass call so features just outside the
   * AOI but within distance are still considered for the join.
   */
  aoiParameterRef: string;
}

/** Type guard for the relational-query action kind. */
export function isOsmRelationalQueryAction(
  action: ToolAction,
): action is OsmRelationalQueryAction {
  return action.kind === 'osm-relational-query';
}

/**
 * Returns a freshly-stubbed relational-query action.  Used by the
 * tool designer when the author switches the action kind to
 * "OSM relational query" and by the new-tool-from-template path.
 *
 * The default is empty enough that the designer's save-time
 * validator can reject it loudly (no preset chosen, no conditions,
 * no AOI parameter) instead of silently shipping a broken tool.
 */
export function emptyOsmRelationalQueryAction(): OsmRelationalQueryAction {
  return {
    kind: 'osm-relational-query',
    relationalVersion: 1,
    anchorPreset: '',
    conditions: [],
    combinator: 'and',
    parameters: [],
    aoiParameterRef: '',
  };
}

/**
 * Catalog of starter recipe templates.  Each entry is a small
 * factory the tool designer surfaces as a "Start from template"
 * option so authors can stamp out a working recipe without
 * hand-wiring every parameter.  The user can edit anything after
 * stamping; the template is just a head start.
 *
 * Add a template by appending an entry to RECIPE_TEMPLATES.  Each
 * template returns a fresh RecipeAction blob (defensive cloning so
 * future edits don't leak across stamps).
 */
export interface RecipeTemplate {
  /** Stable id used as the picker's option key. */
  id: string;
  /** Human-readable label for the picker. */
  label: string;
  /** Short description shown under the label. */
  description: string;
  /** Factory: returns a fresh RecipeAction the editor can adopt. */
  build(): RecipeAction;
}

/**
 * Select-By-Location template.  The canonical recipe we ship as a
 * proof of concept: pick a target layer, pick an AOI (drawn or from
 * the current selection), pick a predicate, optionally a distance,
 * and the runtime updates the target layer's selection with the
 * matching feature ids.
 *
 * Parameter slots:
 *   target:    runtime-host  -- the host app maps a real layer to
 *                               this slot (or the user picks one).
 *   aoi:       runtime-draw  -- the user draws (or pastes) a
 *                               geometry at run time.  Polygon by
 *                               default; the constraint can be
 *                               relaxed by the author after
 *                               stamping.
 *   predicate: runtime-pick  -- defaults to 'intersects'; the full
 *                               five-way set is allowed.
 *   distance:  runtime-input -- only used when predicate='near';
 *                               default 100 m.
 */
const SELECT_BY_LOCATION: RecipeTemplate = {
  id: 'select-by-location',
  label: 'Select By Location',
  description:
    'Select features in one layer based on a spatial relationship to another geometry. Mirrors the classic GIS workflow.',
  build(): RecipeAction {
    return {
      kind: 'recipe',
      recipeVersion: 1,
      parameters: [
        {
          kind: 'feature-source',
          name: 'target',
          label: 'Target layer',
          hint: 'The layer features are selected from.',
          required: true,
          geometryType: 'any',
          binding: { mode: 'runtime-host' },
        },
        {
          kind: 'feature-source',
          name: 'aoi',
          label: 'Area of interest',
          hint: 'Draw a shape (or use the current map view) to define the selection geometry.',
          required: true,
          geometryType: 'polygon',
          binding: { mode: 'runtime-draw' },
        },
        {
          kind: 'predicate',
          name: 'predicate',
          label: 'Spatial relationship',
          binding: {
            mode: 'runtime-pick',
            defaultValue: 'intersects',
            allowed: ['intersects', 'within', 'contains', 'touches', 'near'],
          },
        },
        {
          kind: 'distance',
          name: 'distance',
          label: 'Distance (meters)',
          hint: "Only used when the predicate is 'near'.",
          binding: { mode: 'runtime-input', defaultMeters: 100 },
        },
      ],
      pipeline: [
        {
          tool: 'spatial-filter',
          params: {
            otherSource: { kind: 'parameter', name: 'aoi' },
            predicate: { kind: 'parameter', name: 'predicate' },
            distance: { kind: 'parameter', name: 'distance' },
          },
        },
      ],
      output: { kind: 'selection', targetParameterRef: 'target' },
      selectionLimit: DEFAULT_TOOL_SELECTION_LIMIT,
    };
  },
};

/**
 * Find-OSM-features-near-selection template (#OSM).  Stamps out a
 * working "Show me [user-picked OSM features] within [N] miles of
 * my [drawn AOI / parcel]" tool.  The runtime renders matching
 * features as an overlay on the host map with the required ODbL
 * attribution.
 *
 * Parameter slots:
 *   aoi:      runtime-draw  -- the user draws their area of
 *                              interest on the map at run time.
 *   osm:      runtime-pick  -- the user picks from the iD preset
 *                              catalog and optionally adds tag
 *                              filters (brand=Citgo, etc.).
 *   distance: runtime-input -- meters; default 1609 (~1 mile)
 *                              so the bbox padding feels right
 *                              for the canonical "things near
 *                              this parcel" framing.
 *
 * Pipeline is empty in v1; the recipe runner returns every OSM
 * feature inside the AOI's padded bbox.  Wave 2 will add a
 * spatial-filter step over a transient scope so tighter "exactly
 * within X distance" filtering becomes possible.
 */
const FIND_OSM_NEAR: RecipeTemplate = {
  id: 'find-osm-near',
  label: 'Find OSM features near my area',
  description:
    'Draw an area on the map; pick which OpenStreetMap features to show (gas stations, restaurants, schools, ...); optionally add tag filters (brand, cuisine, ...). Matching features appear on the host map.',
  build(): RecipeAction {
    return {
      kind: 'recipe',
      recipeVersion: 1,
      parameters: [
        {
          kind: 'feature-source',
          name: 'aoi',
          label: 'Area of interest',
          hint: 'Draw a shape on the map; OSM features within (and just outside) this area will show up.',
          required: true,
          geometryType: 'polygon',
          binding: { mode: 'runtime-draw' },
        },
        {
          kind: 'osm-feature',
          name: 'osm',
          label: 'What to look for',
          hint: 'Pick one or more kinds of OpenStreetMap feature.  Optional filters narrow it further.',
          required: true,
          binding: {
            mode: 'runtime-pick',
            allowCustomTagFilters: true,
          },
        },
        {
          kind: 'distance',
          name: 'distance',
          label: 'Search radius',
          hint: 'Pad the area of interest before the OSM query.  Change units on the input if you prefer feet, kilometers, etc.',
          unit: 'miles',
          binding: { mode: 'runtime-input', defaultMeters: 1609.344 },
        },
      ],
      pipeline: [],
      output: { kind: 'osm-features-overlay' },
      sourceParameterRef: 'osm',
      aoiParameterRef: 'aoi',
    };
  },
};

/**
 * OSM Name Search starter (#149).  Same osm-features-overlay
 * output as FIND_OSM_NEAR, but the OSM feature parameter ships
 * with a pre-stamped `name~"…"` (contains, case-insensitive) tag
 * filter so the runtime user can type a place name and get every
 * matching feature back -- the canonical "find every Speedway in
 * this county" / "what's that building called X" workflow.
 *
 * The op selector on the runtime tag-filter UI lets the user
 * switch to exact match or regex; the stamped default is
 * contains because that's the lowest-effort happy path for the
 * dominant use case.
 */
const FIND_OSM_BY_NAME: RecipeTemplate = {
  id: 'find-osm-by-name',
  label: 'Find OSM features by name',
  description:
    "Draw an area on the map; pick what kind of OpenStreetMap feature to look in; type a name (or part of one) and get every match. Handy for 'every Speedway in this county' or 'find the building named Roosevelt Apartments' workflows.",
  build(): RecipeAction {
    return {
      kind: 'recipe',
      recipeVersion: 1,
      parameters: [
        {
          kind: 'feature-source',
          name: 'aoi',
          label: 'Area of interest',
          hint: 'Draw a shape on the map; the search runs inside (and a small buffer beyond) it.',
          required: true,
          geometryType: 'polygon',
          binding: { mode: 'runtime-draw' },
        },
        {
          kind: 'osm-feature',
          name: 'osm',
          label: 'What to look for',
          hint: 'Pick one or more feature kinds, then type the name (or part of one) in the filter value box.',
          required: true,
          binding: {
            mode: 'runtime-pick',
            // Default to a name-substring filter so the user only
            // has to type the value at runtime.  The runtime UI's
            // op picker lets them switch to exact match or regex
            // if they want.
            defaultTagFilters: [{ key: 'name', value: '', op: 'contains' }],
            allowCustomTagFilters: true,
          },
        },
        {
          kind: 'distance',
          name: 'distance',
          label: 'Search radius',
          hint: 'Pad the area of interest before the OSM query.  Change units on the input if you prefer feet, kilometers, etc.',
          unit: 'miles',
          binding: { mode: 'runtime-input', defaultMeters: 1609.344 },
        },
      ],
      pipeline: [],
      output: { kind: 'osm-features-overlay' },
      sourceParameterRef: 'osm',
      aoiParameterRef: 'aoi',
    };
  },
};

export const RECIPE_TEMPLATES: RecipeTemplate[] = [
  SELECT_BY_LOCATION,
  FIND_OSM_NEAR,
  FIND_OSM_BY_NAME,
];

/** Convenience accessor for the canonical Select-By-Location
 *  template.  Useful for tests + the new-item wizard's "stamp out
 *  a working starter" path. */
export function selectByLocationRecipe(): RecipeAction {
  return SELECT_BY_LOCATION.build();
}
