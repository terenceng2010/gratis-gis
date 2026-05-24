# Tool items v2

Status: design proposal, 2026-05-24. Awaiting confirmation before code.

## What we have today

A `tool` item is currently a tiny named-link wrapper. Three action
kinds: `open-url`, `open-item`, `export-layer`. The detail editor is
mostly paste-an-id inputs. The only consumer is the Custom Web App's
Button widget when its `linkKind === 'tool'`, and even that is just
"navigate or download." There is no parameterization, no interaction,
and no concept of running a tool against a piece of host context.

We also have a robust `derived_layer` system: a recipe of `ToolStep`s
that runs against PostGIS and exposes a synthetic feature layer. The
step union already includes `buffer`, `dissolve`, `centroid`,
`spatial-join` (with `within` / `intersects` / `nearest` predicates),
`filter`, `aggregate`, `simplify`, and others. These steps are
parameterized at design-time only: the author picks specific source
layers when they save the recipe.

And the Custom Web App runtime already maintains `selection` state
(`Record<layerId, Set<featureId>>`) and a `selectTool` mode for
interactive click / rectangle / polygon / lasso selection.

The v2 goal is to turn the Tool item into a first-class parameterized
on-demand action that reuses the recipe vocabulary and produces either
a transient selection or a persisted layer.

## Mental model

| Concept       | Persists as            | Updates when       | Runs                                          |
| ------------- | ---------------------- | ------------------ | --------------------------------------------- |
| data_layer    | a feature layer        | on edit            | always (it just exists)                       |
| derived_layer | a recipe over a layer  | on source change   | implicitly on every read (lens over a source) |
| tool item     | a recipe + params      | only when invoked  | only when the user clicks the tool button     |

A tool item is "a derived_layer recipe you have to ask for." Same
spatial primitives under the hood, different lifecycle.

## Shape (proposed)

The Tool item's `data` blob gets a new action kind alongside the
current three:

```ts
type ToolAction =
  | OpenUrlAction
  | OpenItemAction
  | ExportLayerAction
  | RecipeAction;        // NEW

interface RecipeAction {
  kind: 'recipe';
  parameters: ToolParameter[];
  pipeline: ToolStep[];   // borrowed from derived_layer
  output: ToolOutput;
}
```

The pipeline reuses the derived_layer `ToolStep` union. The author
references parameters from inside step params using a small
substitution syntax (`{{paramName}}`), and the runtime resolves the
substitution at execute time.

### Parameters

Each parameter has a slot name (used by the pipeline to reference
it), a label, and a binding mode that decides where the value comes
from when the tool runs.

```ts
type ToolParameter =
  | FeatureSourceParameter
  | PredicateParameter
  | DistanceParameter
  | NumberParameter
  | TextParameter;

interface FeatureSourceParameter {
  kind: 'feature-source';
  name: string;            // 'aoi', 'targetLayer', ...
  label: string;
  geometryType?: 'point' | 'line' | 'polygon' | 'any';
  binding:
    | { mode: 'hardcoded'; itemId: string; layerKey?: string }
    | { mode: 'runtime-host';        // pick from host app's maps
        default?: { itemId: string; layerKey?: string }; }
    | { mode: 'runtime-draw';        // user draws a geometry at runtime
        default?: { geojson: GeoJSON.Geometry }; }
    | { mode: 'runtime-selection'; }; // use the current map selection
  required?: boolean;
}

interface PredicateParameter {
  kind: 'predicate';
  name: string;
  label: string;
  allowed?: SpatialPredicate[];   // intersects | within | contains | touches | near
  binding:
    | { mode: 'hardcoded'; value: SpatialPredicate }
    | { mode: 'runtime-pick'; default: SpatialPredicate };
}

interface DistanceParameter {
  kind: 'distance';
  name: string;
  label: string;
  binding:
    | { mode: 'hardcoded'; meters: number }
    | { mode: 'runtime-input'; default: number; min?: number; max?: number };
  // Only relevant if a parameter elsewhere uses predicate=near, but
  // we don't enforce that statically.
}

// number, text similar shape.
```

### Output sinks

What happens with the pipeline's output when the tool finishes:

```ts
type ToolOutput =
  | { kind: 'selection';
      targetParameterRef: string;   // which feature-source param's
                                    // layer to update selection on
    }
  | { kind: 'derived-layer';
      titleTemplate: string;        // 'Buffer of {{aoi.title}}'
    }
  | { kind: 'data-layer';
      titleTemplate: string;        // materialize once, no live recompute
    };
```

Default and most common output: `selection`. Matt's framing:

> 'Update transient selection state' is the default, however there
> should be a way to save the result as a derived_layer or even a
> regular data_layer.

So the author picks one of the three at design time; we can later add
a 'configurable per run' mode that exposes the choice at runtime.

## A new ToolStep variant: `spatial-filter`

We don't have a "keep rows whose geom satisfies predicate against this
other geometry" step today (only `spatial-join` which decorates
attributes). Adding `spatial-filter` to the union makes Select By
Location a one-step pipeline and unlocks more use cases for
derived_layer too.

```ts
interface SpatialFilterStep {
  tool: 'spatial-filter';
  params: {
    otherSource:
      | { kind: 'data_layer'; itemId: string; layerKey?: string }
      | { kind: 'parameter'; name: string };   // refers to a parameter
    predicate: 'intersects' | 'within' | 'contains' | 'touches' | 'near';
    /** Meters; only used when predicate='near'. May also be `parameter`. */
    distance?:
      | { kind: 'fixed'; meters: number }
      | { kind: 'parameter'; name: string };
  };
}
```

Compiles to `WHERE ST_Intersects(geom, $aoi_geom)` /
`ST_DWithin(geom::geography, $aoi_geom::geography, $meters)` etc.
Same SQL we already use in spatial-join, just a filter shape.

## Backend execution

```
POST /api/portal/tools/:id/run
{
  parameters: {
    aoi: { kind: 'inline-geojson', geometry: { ... } },
    targetLayer: { kind: 'item-ref', itemId: '...', layerKey: '...' },
    predicate: 'intersects',
    distance: 100,
    ...
  }
}

-> {
  output: { kind: 'selection', layerId: '...', featureIds: [1,2,3,...] }
  | { kind: 'derived-layer', itemId: '...' }
  | { kind: 'data-layer', itemId: '...' }
}
```

The handler:

1. Loads the tool item, validates the caller has read on it.
2. Resolves each parameter from the request body, falling back to
   `binding.default` if not provided and the binding is a runtime mode.
3. For each pipeline step, substitutes parameter references and
   validates the resolved shape against the source schema.
4. Compiles to SQL identically to derived_layer's read path. The two
   code paths can share `compilePipelineToSql()`.
5. For `output.kind === 'selection'`: runs `SELECT entity_id FROM ...`
   and returns the IDs. Hard cap (5000 by default; configurable per
   tool) with a `truncated: true` flag mirroring the existing
   features-page endpoint.
6. For `output.kind === 'derived-layer'`: creates an item with the
   resolved recipe. The user is the owner; sharing defaults from the
   tool's run-config.
7. For `output.kind === 'data-layer'`: runs the query once, writes the
   results into a new v3 data_layer table, schema = the pipeline's
   output schema.

## App designer integration

The Button widget's `linkKind === 'tool'` is upgraded:

1. The bare uuid input becomes a `<ToolPicker>` combobox: shows the
   user's accessible tool items (search by name), preview hint on
   hover. Below it, a "+ Create new tool" button.
2. Clicking "+ Create new tool" opens an inline tool editor modal.
   The modal pre-fills:
   - "Layers available in this app" = data_layer item ids referenced
     in the host's maps. The author can pick from these OR pick
     others via a portal-wide item picker.
   - Sensible defaults for the parameter slots based on the host
     maps' geometry types.
3. Save creates a real tool item in the user's org, then assigns its
   id to the button's `toolId`. The button widget keeps a "binding
   overrides" map for any tool parameters the host can fill in
   automatically (e.g. "use the host's main map for `aoi`").

A second mode is also useful: instead of the Button widget, we add a
**Custom Tool widget kind** with first-class tool-mode display (icon,
caption, panel placement). That's a refinement we can do once the
plumbing is in.

## Runtime parameter UI

When a button bound to a recipe tool is clicked:

1. If every parameter has a resolved value (all hardcoded, or
   pre-bound by the host), POST and apply the output.
2. Otherwise, open a small docked panel ("Run: Select By Location")
   with one input per unresolved parameter:
   - `feature-source` + `runtime-draw`: drawing toolbar (point, line,
     polygon) + Done button.
   - `feature-source` + `runtime-host`: layer picker constrained to
     the host map's layers.
   - `feature-source` + `runtime-selection`: shows current selection
     count, "Use selection" button.
   - `predicate` + `runtime-pick`: a chip strip.
   - `distance` + `runtime-input`: number + unit.
3. "Run" submits, the panel turns into a progress chip, output is
   applied to the host map.

## Sharing & deletion

Tools follow the existing item sharing rules. A runtime invocation
requires `read` on the tool and `read` on every layer the tool
references (hardcoded or resolved). The `dependencies` view already
tracks "what items does this item reference"; we extend it to walk
the tool's pipeline + parameters so `/admin/dependencies` and the
deletion-guard logic stay correct.

## Migration

The new action kind lands alongside the existing three. No data
migration needed. The detail editor adds a fourth "Recipe" tab, and
the existing three tabs are untouched. Older tools (open-url etc.)
keep working through the same Button widget path.

## Proof of concept: Select By Location

Recipe:

```
parameters:
  aoi:           feature-source, runtime-draw OR runtime-selection,
                 geometryType=any
  targetLayer:   feature-source, runtime-host, geometryType=any
  predicate:     predicate, runtime-pick,
                 allowed=[intersects, within, contains, touches, near],
                 default=intersects
  distance:      distance, runtime-input, default=100, only-when=predicate==near
pipeline:
  - tool: spatial-filter
    params:
      otherSource: { kind: 'parameter', name: 'aoi' }
      predicate:   { kind: 'parameter', name: 'predicate' }
      distance:    { kind: 'parameter', name: 'distance' }
    appliedTo:     { kind: 'parameter', name: 'targetLayer' }
output:
  kind: 'selection'
  targetParameterRef: 'targetLayer'
```

The starter-tool path in the new-item wizard exposes this recipe as a
template so a user can stamp out a working Select By Location tool
without designing the parameters by hand.

## Ordering of work (proposed)

1. Shared-types for `RecipeAction`, `ToolParameter`, `ToolOutput`,
   and `SpatialFilterStep`. Nothing runs yet, but everything compiles
   and reasonable defaults exist.
2. Backend `spatial-filter` generator + the `tools/:id/run` endpoint
   for `output: selection`. Unit tests against the WV parcels dataset.
3. Tool designer UI for the Recipe action. Parameter editor + step
   editor + output picker + live preview. Replaces the bare-id
   inputs in `items/[id]/tool/detail.tsx`.
4. App designer: tool picker combobox + "Create new tool" inline
   modal, with host-layer pre-fill.
5. Runtime parameter UI: docked panel that prompts for unresolved
   parameters, submits to `/tools/:id/run`, applies selection.
6. Output sinks 2 & 3: derived-layer and data-layer. (Selection is
   enough to ship; persisted outputs are a follow-up.)
7. "New tool from template" wizard entry; ship Select By Location
   as the first starter.
8. End-to-end verification + deploy.

Each step is independently deployable. After step 5 the loop closes
and Matt can build Select By Location by hand; the wizard template
(step 7) just makes it one click instead of a few.

## Open questions

- Naming the new variant: `recipe`, `action`, `pipeline`, `procedure`?
  Leaning `recipe` because that's what we already call the
  derived_layer's pipeline shape.
- Should `spatial-filter` also appear in the derived_layer wizard?
  Probably yes, for free, but ship it through Tool v2 first.
- Output `data-layer` needs to materialize a new table; that's
  non-trivial (schema + observation log) and is a candidate to defer
  until selection + derived-layer are landed.
