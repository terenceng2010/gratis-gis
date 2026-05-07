# Observation Log Engine

**Status:** Draft, 2026-05-07. First full pass.
**Author:** GratisGIS team.
**License:** AGPL-3.0-or-later.
**Supersedes (gradually):** parts of [data-model.md](../data-model.md),
[feature-services.md](../feature-services.md), and the implicit "items
are documents" mental model that runs through the rest of `docs/`.

This document is the contract between present-self and future-self for
the engine pivot decided on 2026-05-07. It explains what we are
building, why, and in what order. When in doubt during implementation,
this doc wins; when this doc is wrong, fix it before fixing the code.

## TL;DR

The substrate of GratisGIS is moving from "AGO-shaped CRUD over PostGIS
tables" to an **observation log** (one append-only table, bitemporal,
spatially and temporally partitioned) with a **lens runtime** on top
(saved queries plus a render spec). The portal-api keeps its
AGO-shaped REST endpoints as a thin translation layer over the engine.
The portal-web UI keeps every word an Esri user expects ("Web Map,"
"Feature Service," "Publish"). The radical change is invisible to end
users on day one and shows up later as user-visible wins: time travel,
provenance, geometry-aware permissions, real-time subscriptions, and
schema-aware semantic search.

## Goals (what we are optimizing for)

In rough priority order:

1. **AGO-familiar UX.** A county GIS analyst should not have to learn
   new vocabulary on day one. Buttons say "Create Map" and "Publish
   Feature Service." (See `rethinking-the-geospatial-portal.pdf` in
   the workspace root for the full argument: familiar surface, novel
   substrate.)
2. **Ease of setup.** A fresh user runs `pnpm install && pnpm
   infra:up && pnpm dev` and is on the portal in under five minutes.
   The engine substrate change must not add a new service to
   docker-compose. It is a schema-and-query-layer change inside the
   existing Postgres, not a new datastore.
3. **Performance** at the sizes our target users care about
   (low-millions of features per layer, sub-second tile serve, sub-100ms
   item-page open). The observation-log model has to be at least as
   fast as the current CRUD model on the same hardware.
4. **Scalability** along three axes: number of layers (10k+ items per
   org), number of features per layer (10M+), and number of concurrent
   readers (100+). All three should hold without horizontal scaling
   for the first year of public use.
5. **Security** that is geometry-aware, attribute-aware, and
   time-aware. Authorization decisions should be policy expressions,
   not view definitions.
6. **First-class time and provenance.** Every value carries the
   author, the timestamp, and a pointer back to where it came from.
   Time travel is a checkbox on a layer, not a recovery procedure.
7. **Real-time** as a default mode. Subscribing to a query is a save
   option on every view that produces data.

## Non-goals (what we are not doing in v1)

- **Federation** between portals. Each GratisGIS install is one node
  for now. Cross-portal queries, CRDT sync, partial replicas to field
  devices: all v2.
- **A custom database engine.** Postgres + PostGIS + pgvector is the
  substrate. We may add DuckDB as a sidecar reader later. We are not
  writing storage code.
- **A custom query language.** The engine DSL is JSON over a small TS
  type. SQL is the implementation, not the user surface.
- **Replacing the UI shell.** The catalog, item pages, sharing UI, and
  admin pages stay where they are. They eventually start speaking to
  the engine instead of the legacy services, but their look does not
  change because of this work.
- **Removing legacy code paths during migration.** Strangler-fig:
  legacy CRUD lives next to the engine until every consumer has been
  migrated. Only then do we delete.
- **Esri vocabulary in user-facing surfaces.** The vocabulary rules in
  CLAUDE.md and `docs/items.md` still apply. Inside the engine we use
  observation, lens, policy. The UI uses dataset, layer, map, form.

## The model in one paragraph

Every state change in GratisGIS, from the smallest attribute edit to
the creation of a whole layer, is recorded as one row in a single
append-only **observation log**. Each row carries who said it, when
they said it, when it was true in the world, what entity it was about,
what attributes changed, and where the change happened (geometry plus
H3 cell). On top of the log we run **lenses**: saved queries that
project the log into a shape (features, tiles, charts, scalars,
streams). The portal's existing concepts (a map, a layer, a form, a
dashboard) are all special cases of lenses. AGO-shaped REST endpoints
in portal-api are the translation layer that lets the existing UI
speak to the engine without knowing it changed.

## Primitives

### Observation

The unit of state. An observation says: at time T, principal P
asserted that entity E (in scope S) has attribute values A, with
geometry G, valid for time interval V, with provenance pointer R.

```ts
// packages/engine/src/types.ts (proposed)

export interface Observation {
  id: string;            // ULID, monotonically sortable
  txTime: Date;          // when we recorded it
  validFrom: Date;       // when the assertion is true in the world
  validTo: Date | null;  // null = still true
  scope: string;         // e.g. "data_layer:abc123"
  entity: string;        // stable id of the thing this is about
  kind: ObservationKind; // 'create' | 'update' | 'delete' | 'derive' | 'observe'
  attrs: Record<string, unknown> | null;
  geom: GeoJsonGeometry | null;
  cell: string | null;   // H3 cell at resolution 7 (for partition routing)
  author: PrincipalRef;  // {sub, displayName} from JWT
  source: SourceRef;     // device, app, ingest job, etc.
  parents: string[];     // observation ids this one was derived from
}
```

A few notes that are easy to get wrong:

- **`txTime` versus `validFrom`** is the bitemporal split. `txTime` is
  always "now-ish" (the system clock when we wrote the row).
  `validFrom` can be in the past (back-dated edits, GPS samples
  arriving after a sync) or, occasionally, the future (scheduled
  changes). The engine must support both.
- **`validTo` is exclusive.** A row with `validTo = null` is the
  current truth. Updating an entity means writing a new row with a
  later `validFrom` and shortening the previous row's `validTo`. We
  never `UPDATE` an observation row in place. Logically we
  `INSERT`-only; physically we may run a triggered or scheduled job
  to set `validTo` on the previous row.
- **`entity` is a stable id, not a row id.** Two observations about
  the same parcel share an `entity`. The combination
  `(scope, entity, validFrom)` is what defines "the parcel as of this
  moment."
- **`kind`** distinguishes user-visible intent. `create` is the first
  observation about an entity. `update` is a subsequent assertion.
  `delete` is a tombstone. `derive` means this row was produced by a
  computation, not a user (and `parents` lists the inputs).
  `observe` is for sensor data and other "this is what we measured"
  cases that are not edits to a curated dataset.
- **`cell` is denormalized.** We compute the H3 cell at write time so
  the row can route to the right partition without joining through
  geometry. H3 resolution 7 (~5 km) is a starting choice; we may
  iterate.

### Lens

A lens is a saved query plus a render spec. It is the answer to a
question the user wants to keep asking.

```ts
// packages/engine/src/lens.ts (proposed)

export interface Lens {
  id: string;
  name: string;
  scope: string;             // 'data_layer:abc' or 'org:foo' or 'global'
  query: LensQuery;          // what features to include
  project: LensProjection;   // which fields, derived columns, joins
  filter: LensFilter[];      // attribute / geometry / time filters
  asOf: AsOfMode;            // 'now' | 'fixed' | 'parameter'
  render: LensRender;        // how to deliver the result
  policy: LensPolicy;        // who can see what
  cache: LensCacheHints;     // materialize, ttl, etc.
}

export type LensRender =
  | { kind: 'features'; format: 'geojson' | 'mvt' | 'wkb' }
  | { kind: 'table';    columns: ColumnSpec[] }
  | { kind: 'chart';    chart: ChartSpec }
  | { kind: 'scalar';   reducer: 'count' | 'sum' | 'avg' | 'min' | 'max' }
  | { kind: 'stream';   transport: 'sse' | 'ws'; throttleMs?: number };
```

A few worked examples of how existing concepts map to lenses:

- A **data_layer** is a lens with `query: { entity: 'parcel' }`,
  `render.kind: 'features'`, `asOf: 'now'`, no filters. It is the
  default "show me the current truth" view.
- A **map**'s layer entry is a lens reference plus styling. The map
  item is itself a small composition that records the basemap,
  viewport, and ordered list of layer references.
- A **dashboard tile** is a lens with `render.kind: 'chart'` or
  `'scalar'`. The dashboard item is a composition of tiles.
- A **form** is a lens with a write-back binding: the form schema
  comes from `project`, the read displays current values, submitting
  the form writes new observations.
- A **subscription** is a lens with `render.kind: 'stream'`. The
  client connects via SSE and gets new observations as they land.

### Policy

A policy is a Cedar-style authorization expression evaluated on every
read and every write. Policies attach to a scope (an org, a layer, a
specific lens, an entity).

```cedar
// example: contractors can read parcels inside their assigned polygon
permit (
  principal in Group::"contractors",
  action == Action::"read",
  resource is Lens::"parcels"
)
when {
  resource.feature.geom in principal.assignedPolygon
};

// example: only owners can write delete observations
permit (
  principal,
  action == Action::"write",
  resource is Lens::"parcels"
)
when {
  resource.kind != "delete" || principal == resource.feature.owner
};
```

We are not committing to Cedar specifically yet; OPA and a
hand-rolled DSL are also in scope. The policy engine choice is an
**open question** (see below). What is fixed is the shape: declarative,
geometry-aware, attribute-aware, attached to lenses, evaluated by the
engine on every read and write.

## Storage

### Observation log table

Single table, append-only, partitioned. Rough Postgres DDL:

```sql
-- apps/portal-api/prisma/migrations/<ts>_engine_observation_log/migration.sql

CREATE EXTENSION IF NOT EXISTS h3;
CREATE EXTENSION IF NOT EXISTS pg_partman;
CREATE EXTENSION IF NOT EXISTS pgvector;

CREATE TABLE observation (
  id           CHAR(26)    PRIMARY KEY,            -- ULID
  tx_time      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_from   TIMESTAMPTZ NOT NULL,
  valid_to     TIMESTAMPTZ,                        -- null = current
  scope        TEXT        NOT NULL,
  entity       TEXT        NOT NULL,
  kind         TEXT        NOT NULL CHECK (kind IN
                 ('create','update','delete','derive','observe')),
  attrs        JSONB,
  geom         GEOMETRY(Geometry, 4326),
  cell         CHAR(15),                           -- H3 res 7
  author_sub   TEXT        NOT NULL,
  source       JSONB       NOT NULL,
  parents      TEXT[]      NOT NULL DEFAULT '{}',
  embedding    VECTOR(384)                         -- text fields, optional
) PARTITION BY RANGE (tx_time);

CREATE INDEX observation_geom_gix
  ON observation USING GIST (geom);
CREATE INDEX observation_scope_entity_validfrom_idx
  ON observation (scope, entity, valid_from DESC);
CREATE INDEX observation_cell_idx
  ON observation (cell);
CREATE INDEX observation_attrs_gin
  ON observation USING GIN (attrs jsonb_path_ops);
CREATE INDEX observation_embedding_ivfflat
  ON observation USING ivfflat (embedding vector_cosine_ops);
```

Partitioning is by `tx_time` monthly via `pg_partman`. Writes always
land in the current partition (sequential, hot). Reads of recent data
hit one or two partitions. Time-travel reads of old data hit the
relevant historical partitions, which are smaller and may live on
slower storage in the future. This is the most boring partitioning
choice that works; we can revisit if we hit a real problem.

H3 cell is denormalized for routing of spatially-local queries. We
will add a secondary spatial partitioning scheme only if measurements
demand it.

### Auxiliary tables

```
lens                       -- saved queries / render specs
lens_dependency            -- lens X reads from layer Y (for lineage)
materialized_view          -- precomputed read shape for a hot lens
materialized_view_refresh  -- log of when each MV was refreshed
policy                     -- Cedar/OPA expressions, scoped
provenance_edge            -- denormalized lineage graph for fast queries
subscription               -- live SSE/WS subscribers (in-memory in v1)
```

`materialized_view` rows are the equivalent of "feature service tile
caches" today, except each one is a query result with a known refresh
strategy (eager, lazy, ttl). The engine decides whether a read hits
an MV or the live log based on freshness requirements declared in
the lens.

`provenance_edge` is a graph of `(observationId, derivedFromId)`
flattened for `WHERE` joins. It lets us answer "what changes upstream
caused this row to differ from yesterday" without recursing through
`parents` arrays.

## Lens runtime

### Query planning in one paragraph

Given a lens read request and an `asOf` parameter, the runtime:

1. Evaluates the policy. If denied, returns 403.
2. Checks for a fresh `materialized_view` row matching this
   `(lens, asOf, filters)` tuple. If found, serves it.
3. Otherwise plans a Postgres query: a `WITH` CTE that selects from
   `observation` filtered by `scope`, `entity` (via the lens query),
   `valid_from <= asOf < COALESCE(valid_to, 'infinity')`, plus the
   lens filters. Joins through `lens_dependency` for derived layers.
4. Renders the result according to `lens.render` (GeoJSON, MVT, table,
   chart, scalar, stream).
5. Optionally writes the result back to `materialized_view` if the
   lens has cache hints.

### Renderer registry

Pluggable. v1 ships with:

- `geojson` (existing portal-web is fed by GeoJSON today; preserves
  compatibility)
- `mvt` (vector tiles via `ST_AsMVT`, served from a hot path that
  hits the MV cache first)
- `geojson_table` for the attribute table view
- `chart_recharts` (delegates to portal-web; the engine ships a
  data-only payload)
- `scalar_json` (a single number)
- `stream_sse` (server-sent events)

Renderers are registered in `packages/engine/src/renderers/` and
declared in `lens.render.kind`. Adding a renderer is one file plus a
case in the dispatcher.

## Write path

```
client → portal-web → portal-api (REST endpoint)
       → engine.write() → policy check
                       → schema validation
                       → INSERT INTO observation
                       → enqueue MV refresh
                       → fanout to subscriptions
```

A few invariants:

- Writes are always **observations**, never row mutations. There is
  no `UPDATE observation SET ...` in user code.
- A single user action can produce multiple observations in one
  transaction (creating a feature with five fields filled in is
  arguably one observation; a form submission that creates a feature
  and uploads three attachments is four).
- The write path is the **only** way to create observations. Imports,
  syncs, derived computations, sensor ingest all go through
  `engine.write()`. This is what makes the audit log free.

## Read path

Two modes:

- **Live read.** Hits the engine query planner directly. Used for
  ad-hoc queries, the attribute table, and freshly-edited views.
- **Cached read.** Hits the `materialized_view` table. Used for tile
  endpoints, dashboard tiles, large public viewers.

The choice is made by the engine based on lens cache hints and
freshness requirements. The client does not see the difference except
in latency.

For the first migration target (data_layer), the read path replaces
the current "select rows from `feature_v3.<table>` joined to schema"
flow. The output shape is identical so the existing portal-web code
does not change.

## Time travel

The engine's bitemporal model means `asOf` is just a parameter on
every read. We expose this two ways:

- **API:** every read endpoint accepts an `asOf` query parameter
  (ISO-8601 timestamp). Default is `now()`. This works for the BFF
  proxy, the public anonymous endpoints, and the lens runtime calls
  alike.
- **UI:** a "View as of..." control on the layer detail page and on
  the map item page. Skeleton in v1 (a date picker dropdown), better
  ergonomics later (a timeline scrubber on the map). The control sets
  the `asOf` URL param and the page re-renders.

Time travel reads do not require a backup or restore. They are not a
disaster-recovery feature. They are a normal operating mode of the
system, available to anyone with read permission on the lens.

## Provenance

Every observation has a `parents` array. Derived layers (clipped,
buffered, joined, aggregated) record which input observations they
came from. The lineage graph is denormalized into `provenance_edge`
for fast queries.

User-visible surfaces in v1:

- "Where did this come from?" link on a feature popup that walks the
  graph one hop and shows the source feature in the source layer.
- "What depends on this?" link on a layer detail page that shows the
  list of derived layers, dashboards, and forms that reference it.
  (This already exists today as `dependents-warning.tsx`; the engine
  version is the same idea on a real graph.)

## Real-time subscriptions

A lens with `render.kind: 'stream'` is a subscription. Clients
connect via SSE, the engine sends new observations matching the
lens query as they land.

Implementation notes:

- v1 uses Postgres `LISTEN/NOTIFY` to fan out new observations to
  in-process subscribers. Single-instance only.
- v2 (when we run multiple portal-api instances) replaces the
  in-process pub/sub with Redis or NATS.
- Throttling is per-lens via `throttleMs`. Default 1000ms.

## Security model

Authentication: unchanged. Keycloak issues JWTs, `JwtAuthGuard`
validates them, `@Public()` opts out. The `Principal` extracted from
the JWT flows into every engine call.

Authorization: policies, evaluated by the engine.

- A lens has a `policy` field that lists Cedar (or equivalent)
  expressions. On read, the engine evaluates the policy against the
  principal and the resource (the lens itself, plus the candidate
  observation rows). Rows that fail the policy are filtered out.
- On write, the policy is evaluated against the proposed observation.
  Failed writes return 403; the observation is never inserted.
- Policies can reference geometry (`resource.feature.geom in
  principal.assignedPolygon`), attributes (`resource.attrs.cost <
  10000`), time (`resource.tx_time > now() - interval '30 days'`),
  and JWT claims (`principal.org == resource.org`).

Audit: free, because every write is an observation. The audit log is
a lens over the `observation` table.

Encryption at rest: existing Postgres TDE / volume encryption is
sufficient. No new requirements from the engine.

Secrets: existing env-var conventions apply.

## Migration plan (strangler fig)

The engine grows alongside the existing code. Each phase ships
independently. `main` is always green and deployable.

### Phase 1: foundation (target: 2 weeks)

**Deliverables:**

- New package `packages/engine` scaffolded with `Observation`, `Lens`,
  `Policy` types and stubs.
- Prisma migration creating `observation`, `lens`, `materialized_view`,
  and friends. Partitioned via pg_partman with one initial partition.
- `engine.write()` function: validates an observation, inserts it,
  returns the inserted row.
- `engine.read()` function: runs a single-scope query against the log,
  returns features as GeoJSON.
- One feature flag, `ENGINE_V2_DATA_LAYER`, default off.

**Acceptance:**

- A test harness can write 10 observations through `engine.write()`
  and read them back as features.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` all green.
- The legacy data_layer creation flow still works, untouched.

### Phase 2: data_layer migration (target: 3 weeks)

**Deliverables:**

- The data_layer creation flow in portal-api gets a feature-flagged
  branch that writes through the engine instead of into
  `feature_v3.<table>`.
- The data_layer read flow gets a feature-flagged branch that reads
  through the engine.
- A shadow-mode comparator: when the flag is half-on (read both, log
  diffs), we log any divergence between legacy and engine results.
- After two weeks of clean shadow logs in dev, flip the flag on for
  new data_layers. Existing layers stay on the legacy path.

**Acceptance:**

- A new data_layer created with `ENGINE_V2_DATA_LAYER=true` round-trips
  identically to one created with the flag off, as judged by the
  shadow comparator across the existing test fixtures.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` all green.
- The portal-web data_layer detail page renders identically against
  the new code path.

### Phase 3: map and lens spec (target: 2 weeks)

**Deliverables:**

- The `Lens` type is finalized.
- Existing `WebMapJSON` shape gets a converter to/from the lens spec.
- The map item type's read endpoint produces a lens spec; the editor
  reads and writes it.
- The portal-web map page continues to use the old format internally;
  the conversion happens at the API boundary. (We do not rewrite the
  map editor in this phase.)

**Acceptance:**

- Existing maps render identically.
- A new map saved through the engine round-trips through the
  WebMapJSON shape and renders in the existing editor.

### Phase 4: time travel and provenance UI (target: 1 week)

**Deliverables:**

- Date-picker "View as of..." control on layer and map detail pages,
  feeds `asOf` query param.
- "Where did this come from?" link on feature popups for derived
  data_layers.
- "What depends on this?" panel migrated from
  `dependents-warning.tsx` to query `provenance_edge` directly.

**Acceptance:**

- A user can pick a past date on a data_layer and see the layer as it
  was on that date.
- A derived data_layer's features show their source feature when
  clicked.

### Phase 5: real-time (target: 2 weeks)

**Deliverables:**

- SSE endpoint `/api/lenses/:id/stream` backed by `LISTEN/NOTIFY`.
- A "Subscribe" button on map and dashboard pages that opens a live
  feed in the side panel.
- Throttling via `throttleMs` lens parameter.

**Acceptance:**

- Editing a feature in one tab causes the feature to update in
  another open tab subscribed to the same map within 1 second.

### Deferred to v2

- Federation and CRDT sync between portals.
- Field-app partial replicas (the existing offline cache stays as is
  for v1; the engine model makes sync easier later but does not
  require it now).
- DuckDB columnar sidecar for analytical reads.
- Embedding-based semantic search across catalog and feature
  attributes.
- Schema inference and field-semantics auto-detection (address,
  phone, person).
- Cedar policy authoring UI (v1 has policies as JSON in the lens
  detail page; a real authoring UI is post-launch).

## Open questions

These are real and should be resolved before or during the relevant
phase, not punted forever.

1. **Policy engine choice.** Cedar, OPA, or hand-rolled?
   Cedar is cleaner for our shape (geometry, attributes, principal in
   group). OPA is more battle-tested. Hand-rolled is fastest to ship
   but accumulates debt. Decide before Phase 2 ends.
2. **H3 vs. S2 vs. geohash for the cell column.** H3 is the current
   pick. Empirically test query plans against a 1M-feature dev fixture
   before committing.
3. **ULID vs. UUIDv7 for `observation.id`.** Both are sortable. ULID
   is more widely supported in our existing code; UUIDv7 is more
   standard. Decide before Phase 1 ships.
4. **MV refresh strategy.** Eager (on every write), lazy (on next
   read), or scheduled (every N seconds)? Probably per-lens hint.
   Pick a default before Phase 2 ships.
5. **Embedding model.** `pgvector` is the substrate; the embedding
   model itself (sentence-transformers? OpenAI ada? local Llama?)
   needs picking when we get to semantic search. Not Phase 1-5.
6. **Backwards compatibility for the legacy data_layer schema during
   migration.** The existing `feature_v3.<table>` rows do not migrate
   into the observation log automatically. We either backfill (one-shot
   script) or read-through (the engine's read path falls back to the
   legacy table for unmigrated layers). Decide before Phase 2 ends.

## Glossary

For readers (including future-self) coming from Esri-land, here are
the engine terms and what they map to:

- **Observation.** A row in the log. Closest equivalent: a single
  edit in an Esri versioned geodatabase. Every change is one of these.
- **Entity.** A stable identifier for a real-world thing. Closest
  equivalent: an `OBJECTID` that survives across edits, but ours is a
  ULID rather than an int and survives schema changes.
- **Scope.** The container an entity lives in. Closest equivalent: a
  feature class. `data_layer:abc123` is "the parcels layer."
- **Lens.** A saved query plus a render spec. Closest equivalents are
  feature service, definition query, web map, and dashboard tile, all
  collapsed into one primitive.
- **Policy.** A geometry-aware, attribute-aware authorization rule.
  Closest equivalent: a combination of role permissions, definition
  queries, and a geodatabase versioned view, written declaratively.
- **Materialized view.** A cached read result. Closest equivalent: a
  feature service tile cache, except it can cache any lens output
  shape, not just tiles.
- **Provenance edge.** A pointer from a derived row to its source.
  Closest equivalent: lineage in ArcGIS Pro's geoprocessing history,
  stored persistently and queryable.
- **Bitemporal.** Two time axes: when something was true in the world
  (`valid_from` / `valid_to`) and when we recorded it (`tx_time`).
  Esri "archive" is single-temporal; this is the strict superset.
- **H3 cell.** A hexagonal grid cell at a fixed resolution. We
  denormalize the H3 cell of each observation's geometry so spatially
  local queries can route to the right partition without recomputing
  from raw geometry. Resolution 7 (~5 km) is the starting choice.

## Things explicitly NOT in v1

To prevent scope creep, the following are out of scope until at least
six months after public launch:

- A custom DSL or query language with its own grammar.
- A replacement for Postgres or PostGIS.
- A non-Postgres event log (Kafka, Pulsar, EventStoreDB).
- Multi-region or multi-cloud deploys.
- A hosted SaaS offering. (Self-host is the only product.)
- A mobile app rewrite. The existing field PWA stays.
- Replacing Keycloak with anything.
- Replacing pg_tileserv. (We may remove it later as the engine
  produces tiles directly, but not in v1.)
- Replacing MinIO with anything.

## How to read this document going forward

When implementing a phase, this doc is the contract. If implementation
reveals that a choice in this doc was wrong, **fix the doc before
fixing the code**. The doc and the code should agree at all times.

When proposing a new feature that does not fit the lens model, that is
a signal: either the feature does not belong in v1, or this doc needs
a section. Lean toward the former.

When in doubt, the framing is: **familiar surface, novel substrate.**
The user clicks "Create Map." Underneath, we write a lens. The user
clicks "Publish Feature Service." Underneath, we register a lens in
the catalog with `render.kind: 'features'`. The vocabulary is the
lifeline; the substrate is the leverage.
