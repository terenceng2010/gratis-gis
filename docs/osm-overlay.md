# OpenStreetMap overlay (#OSM)

Status: design proposal, 2026-05-24.  Awaiting confirmation before code.

## What we're building

A first-class way to query OpenStreetMap data on demand from
GratisGIS tools, maps, and recipes — without forcing the user (or
the tool author) to ever write Overpass QL.

The target user question is something like:

> "Show me all Citgo gas stations within 1 mile of my parcel."

The user should answer that by:

1. Selecting a parcel on a map.
2. Clicking a tool.
3. In the runtime panel: pick "Gas stations" from a multi-select
   dropdown, type `brand=Citgo` into a tag-filter field, set
   distance to 1 mile, hit Run.
4. Watch the matching gas stations appear on the map.

No pre-defined OSM layer.  No saved query item to maintain.  The
tool runner hits the Overpass API at execution time, caches the
result briefly, and feeds it through the same recipe pipeline
that any other data source flows through.

## Why this fits

GratisGIS today is a portal for the data you bring in.  Adding
OSM elevates it to a portal that knows about the physical world.
That's the gap between AGO and AGO + Living Atlas, except OSM is
free, globally maintained, and not paywalled.

It also rides cleanly on the Tool item v2 work that just shipped.
Every architectural surface that needs to consume "where are the
restaurants near this AOI" already exists: maps, data_layers,
derived_layers, recipe tools.  We just need one new "source" kind
and the rest plugs in.

## Substrate (the small new pieces)

Three additive pieces in the recipe vocabulary.  Nothing existing
changes shape; everything new is opt-in.

### 1. New parameter kind: `osm-feature`

Joins the existing parameter union (`feature-source`, `predicate`,
`distance`, `number`, `text`) as a sixth kind.  Tool authors drop
this on a recipe whenever a step needs to consume OSM data.

```ts
interface OsmFeatureParameter {
  kind: 'osm-feature';
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  binding:
    | {
        // Author bakes in "always gas stations".  User just
        // provides AOI + distance at runtime.  Use case: a tool
        // dedicated to one specific OSM lookup ("Find pharmacies
        // near my facility").
        mode: 'hardcoded';
        presetIds: string[];           // one or more
        tagFilters?: OsmTagFilter[];   // extra constraints
      }
    | {
        // User picks at runtime.  This is the flexible
        // "guided query" mode -- the one that powers
        // "Show me [user picks: gas stations] (filter: brand=Citgo)
        //  within 1 mile of my parcel".
        mode: 'runtime-pick';
        defaultPresetIds?: string[];
        defaultTagFilters?: OsmTagFilter[];
        // Author can narrow what the user sees.  Empty / omitted
        // means "any preset in the catalog".
        allowedCategories?: string[];  // e.g. ['amenity', 'shop']
        allowedPresetIds?: string[];   // explicit subset
        // Whether the user can add free-form tag filters at
        // runtime.  Off when the tool author wants a strictly
        // guided experience (only the presets, no filtering).
        allowCustomTagFilters?: boolean;
      };
}

interface OsmTagFilter {
  key: string;   // 'brand'
  value: string; // 'Citgo'  -- supports the literal-equals case;
                 //             v1 ships with op='equals' only,
                 //             contains / regex queued
  op?: 'equals' | 'contains' | 'regex';
}
```

### 2. New SourceRef variant: `osm-query`

The other-source side of a spatial-filter / spatial-join step can
now point at an OSM query directly:

```ts
type SourceRef =
  | { kind: 'data_layer'; ... }
  | { kind: 'inline-geometry'; ... }
  | { kind: 'parameter'; name }
  | {
      kind: 'osm-query';
      // What the author wired into the recipe.  The recipe
      // runner expands this to bbox + Overpass QL at execute
      // time and feeds the result back into the SQL pipeline as
      // a transient PostGIS scope.
      presetIds: string[];
      tagFilters?: OsmTagFilter[];
      // Optional bbox padding (meters) applied to the AOI's
      // bbox before the Overpass call.  Defaults to the recipe
      // step's distance value when the step has one.
      bboxPaddingMeters?: number;
    };
```

When the tool author wires `osmFeatures` (parameter) into a
spatial-filter's `otherSource`, the underlying step's
`otherSource` is `{ kind: 'parameter', name: 'osmFeatures' }`
at design time.  At runtime the recipe runner resolves that into
either:

- the literal `osm-query` shape when the param is `hardcoded`, or
- an `osm-query` shape derived from the user's runtime picks when
  the param is `runtime-pick`.

Either way, the downstream spatial-filter generator sees a
resolved `osm-query` source and treats it the same as a data_layer.

### 3. Recipe-runner OSM resolver

A small backend module that, given a resolved `osm-query` source
+ an extent (computed from the AOI buffered by the recipe's
distance), does:

1. **Hash** the (preset ids, tag filters, bbox-rounded) tuple to a
   cache key.
2. **Check the result cache** (PostgreSQL table keyed by hash,
   with `fetched_at` + a TTL we read off config).  If fresh, use
   the cached scope.
3. **Build the Overpass QL** from the preset definitions + the
   user's tag filters (see "Preset catalog" below).
4. **Call the configured Overpass endpoint** (default
   `https://overpass-api.de/api/interpreter`; org config can
   override).  Hard-cap on result size to protect us from a
   runaway "every building in California" query: 50k features by
   default, configurable per org.
5. **Convert** OSM nodes/ways/relations to GeoJSON Features (own
   tiny converter, ~600 lines; vendor `osmtogeojson` if it ports
   cleanly).
6. **Write** the features to a transient observation-log scope
   named `osm:<hash>` so the SQL compiler can read it like any
   other data_layer.
7. Stamp `fetched_at` so the next call within TTL hits the cache.

The transient scope persists in the observation log but isn't
exposed as an item, doesn't appear in items lists, and gets
garbage-collected when its hash isn't touched for ~7 days.  Same
storage as data_layer features; same SQL access path; just no
item wrapper.

## Preset catalog

Overpass QL is the UX cliff.  We avoid it by giving authors and
users a curated "feature catalog" instead -- a list of well-named
things ("Gas stations", "Restaurants", "Schools", "Parks", "Fire
hydrants", "Bus stops", "Building footprints", "Rivers", "Cycling
routes") backed by known OSM tag combinations.

Source: vendor the [iD Tagging Schema](https://github.com/
openstreetmap/id-tagging-schema), the same preset library the
official OSM web editor uses.  It carries ~1,800 presets in
internationalized JSON, each with a name, an icon hint, and the
exact tag combination that defines the feature.

We start with a curated subset for v1 -- maybe 80-120 presets
covering the obvious user-facing categories:

| Category          | Sample presets                                |
| ----------------- | --------------------------------------------- |
| Food + drink      | Restaurants, cafes, bars, fast food           |
| Transport         | Gas stations, EV charging, parking, bus stops |
| Education         | Schools, universities, libraries              |
| Health            | Hospitals, clinics, pharmacies                |
| Civic             | Police, fire stations, post offices, city hall|
| Recreation        | Parks, playgrounds, sports fields, trails     |
| Retail            | Supermarkets, convenience stores, malls       |
| Natural           | Rivers, lakes, forests, peaks                 |
| Infrastructure    | Hydrants, power lines, cell towers, manholes  |
| Boundaries        | Country, state, city, ZIP, neighborhood       |

The catalog file lives at
`apps/portal-web/content/osm/preset-catalog.json`.  Same
"content/" tree as the help docs + the changelog, so the Next.js
standalone build traces it.  The full ~1,800-preset set can be
added later in waves; we don't need to ship them all at once.

Each catalog entry:

```json
{
  "id": "amenity_fuel",
  "label": "Gas station",
  "category": "transport",
  "icon": "fuel",
  "tags": [{ "key": "amenity", "value": "fuel" }],
  "geometries": ["node", "way"],
  "description": "Vehicle fuel filling station."
}
```

The Overpass QL generator stitches each preset's `tags` into a
union, restricted to the declared `geometries`, plus any
runtime-supplied tag filter as an AND constraint.

Example query for "Gas stations with brand=Citgo within this bbox":

```
[out:json][timeout:25];
(
  node["amenity"="fuel"]["brand"="Citgo"]({{bbox}});
  way["amenity"="fuel"]["brand"="Citgo"]({{bbox}});
);
out body geom;
```

## Author-time UX

In the Tool item v2 recipe editor, the parameter picker grows a
sixth "Add parameter" option: **OSM feature**.  Selecting it
opens a small panel with:

- **Slug + label + hint** (same shape as other params).
- **Binding mode** toggle: Hardcoded / User picks at runtime.
- For Hardcoded: a preset multi-select (catalog browser) + a
  tag-filter mini-editor (add row, key + value, remove).
- For User picks: defaults for both (preset + filter), plus an
  allowlist toggle ("Limit which categories the user can pick
  from") and an "Allow custom tag filters" checkbox.

Inside a spatial-filter step's "Other source" picker, the author
sees a new third option alongside "Pick a layer" and "Use a
parameter": **Query OpenStreetMap**.  Picking it lets the author
bake an OSM source straight into the recipe (the hardcoded
variant on the SourceRef itself, bypassing the parameter
indirection).  Useful for tools where the OSM source never
changes ("Find buildings near this parcel" - buildings is
hardcoded).

For the more flexible cases ("Find user-chosen OSM features near
this parcel"), the author uses a parameter and wires it.  Same
pattern as the predicate / distance parameters today.

## Runtime UX

In the RecipeRunPanel that opens when a user clicks a recipe
tool, the `osm-feature` parameter renders as:

- A **preset picker**: combobox of catalog presets, grouped by
  category, with the icons from the preset definitions.  Supports
  multi-select.  When the parameter has an `allowedCategories`
  or `allowedPresetIds` restriction, the picker only shows the
  allowed entries.
- A **tag-filter editor**: rows of `key = value`.  Add / remove
  rows; values are free text.  Hidden when the parameter has
  `allowCustomTagFilters: false`.
- A small **preview chip**: shows how many features the query
  would return, computed from a quick `count()` Overpass call
  triggered on a debounced input.  Helps the user spot a too-
  broad query before they Run.

Defaults seed from the parameter's binding.

The "Find OSM features near my selection" starter template ships
with all the runtime affordances on by default.  Variants ("Find
gas stations near my selection", with the preset hardcoded) are
easy to stamp out from the same recipe by switching one parameter
to hardcoded mode.

## Output models

Two distinct user-visible outcomes worth thinking through:

1. **"Show me the OSM features that matched."**  Output sink is
   a new variant: `{ kind: 'osm-features-overlay' }`.  The runner
   returns inline GeoJSON Features.  The map widget overlays
   them as a transient layer with a sensible default symbol from
   the preset + a "Save as data layer" button so the user can
   materialise the result into a real data_layer if they want.

2. **"Which of my parcels have an OSM-matched feature within X."**
   Same `selection` output sink we already have.  The recipe's
   pipeline spatial-filters my parcel layer using the OSM result
   as the right side; matching parcel ids come back as the
   selection set.

Both ship in wave 1.  The `osm-features-overlay` variant is new;
`selection` works unchanged.

## Endpoint + caching

Default endpoint: `https://overpass-api.de/api/interpreter`.

Per-org config knob (`OSM_OVERPASS_ENDPOINT`) lets an operator
point at a self-hosted Overpass server.

Caching is a single PostgreSQL table:

```sql
CREATE TABLE osm_query_cache (
  hash         TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,      -- the observation-log scope key
  preset_ids   TEXT[] NOT NULL,
  tag_filters  JSONB,
  bbox         JSONB,
  feature_count INTEGER,
  fetched_at   TIMESTAMPTZ NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  endpoint     TEXT NOT NULL
);
```

TTL: 1 hour by default.  A scheduled task scrubs expired rows +
their observation-log scopes nightly.  Per-tool-run invocations
of the same query within TTL collapse to one upstream call.

## Attribution

ODbL requires "© OpenStreetMap contributors" on any view that
displays OSM data.  Treat this as a hard requirement, not a
nice-to-have:

- Every map widget that hosts an OSM-overlay output gets an
  attribution chip in the bottom-right ("Data © OpenStreetMap
  contributors", linking to the OSM licence page).
- The "Save as data layer" path on an OSM-features-overlay
  result writes the attribution into the data_layer item's
  metadata, so the layer carries it forward whenever it's
  displayed downstream.
- The credits page (`/credits`) gains an "Open data sources"
  section listing OSM with the attribution + licence link.

## Phasing

Three waves, each independently deployable.

### Wave 1 -- the primitive

- Shared-types: `OsmFeatureParameter`, `osm-query` SourceRef
  variant, `osm-features-overlay` output sink.
- Portal-api: Overpass adapter (QL builder, HTTP client, OSM→
  GeoJSON converter), recipe-runner OSM resolver, cache table +
  migration, observation-log scope helper for transient OSM data.
- Portal-web: preset catalog JSON (~80 presets), recipe-editor
  surfaces (parameter card + spatial-filter source picker entry),
  RecipeRunPanel inputs (preset multi-select + tag-filter
  editor), map attribution chip when an OSM overlay is mounted.
- Tooling: a "Find OSM features near my selection" starter
  template added to RECIPE_TEMPLATES.

End-of-wave-1 demo: an author creates the starter, drops a
Button widget bound to it on a Custom Web App, ends a user
selects their parcel, clicks the button, picks "Gas stations"
+ `brand=Citgo` + 1 mile, hits Run, sees Citgo gas stations on
the map.

### Wave 2 -- breadth + reliability

- Full preset catalog (all 1,800 iD presets) with category
  filtering in the picker.
- Per-org Overpass endpoint override + admin UI to set it.
- Larger result handling (paging + streaming for >50k features).
- "Save overlay as data_layer" button on the map for any OSM
  result.
- Per-recipe TTL override (some workflows want fresh-on-every-
  run, some want once-per-day).

### Wave 3 -- power features

- Optional `osm_layer` item type for the "curate a persistent OSM
  layer with scheduled refresh" workflow.  Built on top of the
  wave-1 primitive: it's just an osm-query with a schedule + an
  item wrapper.
- Raw Overpass QL escape hatch in the parameter binding (toggle
  a checkbox; the picker becomes a syntax-highlighted textarea).
- Tag-filter operators beyond equals (contains, regex).
- "Diff vs last refresh" view for power users tracking change.

## Open questions

- **Preset catalog size for wave 1**: I'm planning 80-120
  hand-picked presets.  Too few = users hit "now write QL".
  Too many = picker becomes overwhelming.  Worth a quick review
  of the proposed category list above before we lock the v1
  catalog.
- **Output sink default**: should the starter template default
  to `osm-features-overlay` (show the OSM features) or
  `selection` (select matching parcels)?  My read: overlay,
  because that's the "Show me Citgo" framing.  Selection-on-
  target is a tool variant the author can stamp out separately.
- **Free-form tag-filter UX**: a `key = value` row editor is the
  minimum.  Do we also want autocompletion on common keys
  (`brand`, `cuisine`, `operator`, `name`)?  Easy to add but it
  needs a key-frequency catalog the iD schema doesn't carry
  directly.

## Out of scope (intentionally)

- **Editing OSM through GratisGIS**.  This is a read path only.
  OSM editing belongs in iD or JOSM.
- **Overpass diff streams** (`adiff`).  Useful for change
  detection but heavy; wave 3 if at all.
- **Tile-based OSM**.  Tile rendering (Mapbox / OpenMapTiles /
  Mapnik) is a different problem space — it's "show me an
  illustrated map of the world", not "give me features I can
  analyse."  We already support adding tiled OSM basemaps; this
  doc is strictly about feature-level queries.
