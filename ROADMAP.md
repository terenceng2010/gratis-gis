# GratisGIS Roadmap

A phased delivery plan. Each phase is intended to be independently useful and
demo-able; phases intentionally build on one another.

---

## Phase 0: Scaffolding ✅

- [x] Project charter, architecture, roadmap
- [x] Monorepo (pnpm + Turborepo)
- [x] Docker-compose infra (Postgres/PostGIS, Keycloak, MinIO, pg\_tileserv)
- [x] Shared packages skeleton
- [x] CI pipeline
- [x] Local dev loop: `pnpm dev` brings up everything

## Phase 1: Portal MVP (pillar 1) ✅

Goal: a usable portal with auth, items, and sharing. This is the bedrock.

- [x] Keycloak realm + JWT verification in portal-api
- [x] Prisma schema for users, groups, items, item\_shares, orgs
- [x] `/users/me`, `/groups`, `/items` REST endpoints
- [x] Sharing permission checks (private → groups → org → public)
- [x] portal-web: sign-in, my items, item detail, sharing UI
- [x] Group management UI (create group, invite, roles)
- [x] Search + filter on items
- [x] Folders (multi-membership) + smart folders
- [x] Soft delete + trash + cascade-revert
- [x] Per-user capability overrides + admin housekeeping dashboard

**Status:** shipped. Two users in two groups can each create items, share
with their group, and see each other's shared items but not private ones.
Ownership reassignment, time-bounded shares, and folder cascade are all in.

## Phase 2: Web Maps (pillar 2) ✅

- [x] Data layer endpoint backed by PostGIS (multi-sublayer v3 model)
- [x] Upload GeoJSON / Shapefile / GeoPackage / GDB / KML → creates a
      data\_layer item
- [x] pg\_tileserv integration with per-layer permission proxy
- [x] Map item type (basemap + layer refs + styling)
- [x] Map viewer in portal-web using MapLibre GL
- [x] Map authoring UI (Add Layer dialog, simple + unique-values +
      class-breaks renderers, popups, scale visibility, labels)
- [x] Per-share row scope (`all` / `own`) and geographic clip (polygon)
- [x] Per-layer access matrix on web maps (override item-level sharing
      down, never up)
- [x] Editor item type with right-docked AGO-style edit pane
- [x] WebMap JSON export (`GET /items/:id/web-map.json`) for ArcGIS Pro,
      AGO, QGIS, kepler.gl

## Phase 3: Form Designer + Data Collection (pillar 4) ✅

This is the highest-differentiation pillar. We consolidated survey-based
data collection and field geometry capture into one experience.

- [x] Form-builder UI in portal-web (`/forms/[id]`)
- [x] `packages/form-schema` finalized
- [x] Form runtime in portal-web + field PWA (single shared renderer)
- [x] Field PWA (Next.js): browse items, download offline, fill forms,
      capture points/lines/polygons, photo / sketch / barcode / video /
      audio capture
- [x] Per-edit queue + selective retry (a bad row doesn't poison the rest)
- [x] Submissions stored in PostGIS (paired data\_layer per form,
      schema-version-aware)
- [x] Schema-break notifications fan out to deployment owners + field
      downloaders before next sync

## Phase 4: App Builder (pillar 3) 🚧

- [x] Web-app template framework (Editor / Viewer / Survey templates)
- [x] Convert-to-Custom escape hatch
- [ ] Custom-app grid runtime (CSS-grid layout engine + per-widget renderers)
- [ ] Drag-drop visual designer for the Custom template
- [ ] Real chart widget (Recharts data adapter)
- [ ] Map / List / Filter / Text / Image / Attribute Table widget kit

**Exit criteria:** configure a 3-widget app (map + list + filter) against
a data layer without writing code, and publish it.

## Phase 5: Reports + Dashboards (pillar 5) 🚧

- [ ] Report template item type (markup + placeholders + chart specs)
- [ ] Report runner (render to HTML, PDF, docx)
- [ ] Scheduled report delivery via email
- [ ] Dashboard item type (live charts over feature data)

## Phase 6: Tool & Widget Builder (pillar 6) 🚧

- [x] Derived-layer item type (chained PostGIS spatial pipelines)
- [x] Tool catalog: buffer, centroid, convex-hull, dissolve, fishnet,
      simplify, densify, vertices, calculate-geometry, nearest-neighbor,
      random-sample, top-n, bbox
- [ ] React Flow node-graph authoring canvas (`apps/tool-builder`)
- [ ] Tool item type runtime (`apps/tool-runner` worker)
- [ ] Tools as draggable widgets in the App Builder

**Exit criteria:** visually build a "buffer + intersect" analysis that
takes two data\_layer inputs, saves results to a new derived\_layer, and
publishes the same graph as a draggable widget in the app builder.

## Engine Substrate (foundational, ✅)

Cross-cutting work that underpins every pillar. Landed alongside Phase 4 / 6
in pre-v1.

- [x] Observation-log table + bitemporal model (Phase 1, migration
      `20260507120000_engine_observation_log`)
- [x] Engine adapter for data\_layer reads + writes (Phase 2.1 / 2.2)
- [x] V3TablesService rewires through engine (Phase 2.4)
- [x] DerivedLayersService source-read through engine (Phase 2.7)
- [x] Stop creating per-layer fs\_ tables; engine owns scope (Phase 2.5)
- [x] Backfill + drop legacy fs\_ tables (Phase 2.6a migration)
- [x] Module rename `features-v3 → data-layer` (Phase 2.6b)
- [x] Lens type + Esri WebMap JSON converter (Phase 3)
- [x] WebMap endpoint at API boundary (`GET /items/:id/web-map.json`)
- [x] Cedar policy engine wired (`@cedar-policy/cedar-wasm`); SharingService
      delegates canRead / canEdit / canDownload / canAdmin to PolicyService
      (Cedar Phase A + B)
- [ ] Cedar Phase C: lens-level custom policies + geometry-aware predicates
      (e.g. "contractors only see parcels inside their assigned polygon")
- [ ] WebMap JSON import (reverse direction): ingest an Esri WebMap as
      a portal `map` item

## Phase 7: Hosted Jupyter (deferred to v2)

The original Phase 6 pillar (hosted JupyterHub + per-user single-user
servers + a `gratisgis` Python client) is deferred from v1. Cost rationale:
running multi-user JupyterHub (KubeSpawner, per-org images, secret rotation,
kernel isolation) doesn't fit a pre-v1 single-developer project, and the
use cases it covered are served by:

- the **tool** item type (reusable, parameterised computation living
  inside the portal sharing model)
- **bring-your-own external Jupyter** pointed at the engine's read-only
  data API with a personal access token; geographic share limits are
  still enforced server-side

See [docs/notebooks.md](./docs/notebooks.md). Re-introducing the hosted
runtime is a two-line schema change plus a UI surface; nothing in the
engine foundation forecloses it.

## Phase 8: Hardening

- [ ] **`pg_partman` monthly partitioning of the `observation` table.**
      Phase 1 deferred this so the primary key could stay on `id` alone
      (a partition column requirement would have forced a composite
      `(id, tx_time)` PK). The deferred work concentrates the engine's
      operational load on a single growing table: autovacuum work,
      index size, lock contention, and the cost of any future
      `ALTER TABLE` all scale linearly with edit history. Land
      partitioning before observation row count crosses ~10M, or
      before the table's index footprint affects p95 read latency,
      whichever comes first. Hot writes go to the current partition
      (sequential), recent reads hit one or two partitions, time-
      travel reads of older data hit historical partitions which can
      eventually live on slower / cheaper storage. Composite PK
      becomes `(id, tx_time)`; the existing
      `observation_scope_entity_validfrom_idx` becomes a per-partition
      index. Migration is non-trivial (Postgres can't `ATTACH
      PARTITION` an existing table with a single-column PK, so the
      cutover involves either pg\_partman's swap-and-rename or an
      offline rebuild); plan accordingly.
- [ ] Verify Postgres page-level checksums are enabled on the prod
      cluster. The engine concentrates feature data into one table,
      so page checksums are now load-bearing for catastrophic-
      corruption detection. Adding to an existing cluster requires a
      `pg_checksums --enable` pass, which is offline.
- [ ] AuthZ policy tests (Cedar Phase B already added 50; more needed
      around lens-level policies in Phase C)
- [ ] Load tests for tile serving
- [ ] Backup / restore tooling (basic landed; HA story TBD)
- [ ] Migration guides from common cloud-GIS export formats

---

## Milestone Cadence

Original solo-developer estimates (now historical):

| Phase | Duration |
| --- | --- |
| 0 – Scaffolding | 1–2 weeks |
| 1 – Portal MVP | 4–6 weeks |
| 2 – Web Maps | 4–6 weeks |
| 3 – Forms + Field App | 8–12 weeks |
| 4 – App Builder | 6–10 weeks |
| 5 – Reports + Dashboards | 4–6 weeks |
| 6 – Tools | 6–10 weeks |
| Engine substrate | (rolled into 2 / 6) |

Solo effort actuals are roughly tracking the higher end of these ranges with
the engine substrate work pulled in alongside the user-facing phases. Each
phase boundary is defined so the ship brings real value even if the next
phase slips.
