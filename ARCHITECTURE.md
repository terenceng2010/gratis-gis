# GratisGIS Architecture

This document describes the service topology, boundaries, and cross-cutting
concerns for the GratisGIS platform. It complements `README.md` (what we're
building) and `ROADMAP.md` (when we're building it).

## Design Principles

1. **One-command install.** A small org should go from a fresh VM to a
   working portal in under 30 minutes, with one command. Every architectural
   choice is measured against this bar. We will *not* ship something that
   takes a week of consulting to stand up. See [docs/deployment.md](./docs/deployment.md).
2. **One domain model, everywhere.** The `Item` concept (with owner, sharing,
   and type) is the backbone: web maps, feature collections, forms, web apps,
   and reports are all items. This is a familiar content-portal pattern and
   lets a single portal, sharing, and search layer serve every product.
3. **TypeScript across all surfaces** so form schemas, sharing logic, and
   geometry types can be reused in the API, web portal, app builder, and
   field app.
4. **Offline-first for collection.** The field app treats online as a bonus;
   the sync engine is first-class.
5. **Composable OSS infra.** Identity (Keycloak), storage (MinIO), tiles
   (pg\_tileserv), and geoprocessing are swappable.
6. **Strict service boundaries.** Each app (portal-api, portal-web, field-app)
   is independently deployable; cross-service contracts live in
   `packages/shared-types`.
7. **Sensible defaults > configuration.** Every knob has a good default.
   Admins should never *have* to read a reference manual; they should be
   able to, when they want to tune something.
8. **Polish is a feature.** Every surface (portal, app builder, field app)
   must feel crafted. Dated, "engineer-built" UI is off-brand. See
   [docs/design-system.md](./docs/design-system.md) for the standards
   every app ships against (typography, motion, empty states, a11y,
   loading skeletons, dark mode).

## System Topology

```
            ┌────────────────────────┐
            │    Identity: Keycloak  │  OIDC / JWT
            └──────────┬─────────────┘
                       │
 ┌─────────────┐   ┌───┴───────────┐   ┌────────────────┐
 │ portal-web  │──▶│  portal-api   │──▶│ PostgreSQL 16  │
 │ (Next.js)   │   │  (NestJS)     │   │   + PostGIS 3  │
 └─────────────┘   └───┬───────────┘   └────────────────┘
                       │
                       ├──▶  MinIO (object storage: attachments, uploads)
                       ├──▶  pg_tileserv (vector tiles from PostGIS)
                       │
 ┌─────────────┐       │
 │  field-app  │───────┘  (React Native, sync via REST + CouchDB-style deltas)
 │ (RN/Expo)   │
 └─────────────┘
```

## Services

### portal-api (NestJS, Node 20)

The single authoritative backend. Exposes REST + JSON; modules:

- `auth/`. Keycloak JWT verification guard, user profile sync
- `users/`. `GET /users/me`, org membership
- `groups/`: groups, memberships, roles
- `items/`. CRUD + type-specific payload storage
- `sharing/`: permission model (`self | group | org | public`)
- `features/`: feature-service endpoints backed by PostGIS tables
- `forms/`: form schema items + submission endpoint (offline-friendly)
- `sync/`: delta sync API for the field app

OpenAPI spec is auto-generated and published at `/docs`.

### portal-web (Next.js 14, App Router)

Consumes portal-api. Uses `next-auth` with a Keycloak provider. Server
components do data fetching with the user's JWT forwarded; client
components handle interactive UI (maps, builders).

### notebook-hub (future, JupyterHub)

A JupyterHub instance fronted by Keycloak (OIDC). Each Jupyter notebook is
registered as an `Item` of type `notebook`. The hub spawns per-user
single-user servers (Docker containers in dev, Kubernetes pods in prod).
A small Python client library `gratisgis` (shipped separately) exposes the
portal-api to notebook code with the current user's token so the same
sharing rules apply transparently.

See [docs/notebooks.md](./docs/notebooks.md).

### tool-builder + tool-runner (future)

`tool-builder` is a React Flow-based authoring app. Users compose a graph of
typed nodes (inputs, spatial ops, SQL steps, HTTP fetches, outputs). The
graph is saved as a `tool` Item.

`tool-runner` is a Node worker service that executes tools. It preferentially
pushes work down to PostgreSQL/PostGIS (most geospatial operations already
exist as SQL), falls back to turf.js in-process for lightweight vector ops,
and can delegate Python-heavy steps to a notebook kernel in
`notebook-hub`. Jobs expose status over a REST endpoint and emit progress
events via Server-Sent Events.

Tools can also be exported as drag-and-drop widgets consumable by
`app-builder`. The widget manifest declares the tool's inputs, outputs, and
UI bindings.

See [docs/tool-builder.md](./docs/tool-builder.md).

### field-app (future, React Native + Expo)

Single app for all data collection:

- Browse items shared with you
- Download a form/web-map for offline use
- Collect features (forms + geometry capture)
- Sync when online (conflict-aware deltas)

Uses the **same form renderer** as portal-web (shipped from
`packages/form-renderer`), so the form designer produces artifacts that
render identically on web and mobile.

### Shared packages

- `packages/shared-types`. API contracts, enums, branded IDs
- `packages/form-schema`. TypeScript types & JSON Schema for form definitions
- `packages/form-renderer`: (future) React components that render a form
  schema, isomorphic across Next.js and React Native
- `packages/geo`: (future) geometry helpers, spatial utilities (wraps turf.js)
- `packages/ui`: shared React components (buttons, dialogs, tables)

## Data Model (high-level)

```
Organization 1───* User *───* Group
       │                       │
       └────────── owns ───────┤
                               │
Item *──── ItemShare *── (Group | User | Org | public)

Item.type ∈ { web-map, feature-service, form, web-app, report, dashboard, ... }
```

See [docs/data-model.md](./docs/data-model.md) for full detail.

## Authentication & Authorization

- Keycloak issues OIDC tokens. `portal-api` verifies signatures using the
  realm's JWKS.
- Each user has an `Organization` scope. Items are owned by a user and
  shared via `ItemShare` rows.
- Sharing scopes follow a familiar portal pattern: `private`,
  `shared-with-group(s)`, `org`, `public`.
- Roles within a group: `member`, `admin`. Org roles: `viewer`, `publisher`,
  `admin`.

See [docs/auth-model.md](./docs/auth-model.md) for token flow and claims.

## Geospatial Storage

All feature data lives in PostGIS. Each feature collection is a table under
a tenant-scoped schema (`org_<uuid>.features_<item_uuid>`). Tiles are served
by pg\_tileserv with a permission-aware proxy layer in `portal-api`.

## Spatial Reference Policy

**Storage is always EPSG:4326 (WGS 84 geographic).** Every PostGIS
geometry column in the portal is declared `GEOMETRY(<type>, 4326)`.
Bounding boxes, geo-limits, and `ST_Intersects` filters all operate
in lat/lng. This is the same convention ArcGIS Online hosted feature
services use, and matches GeoJSON's RFC 7946 implicit CRS.

**Ingest reprojects.** `IngestService` reads every uploaded file's
source SRS via GDAL, builds a `CoordinateTransformation` to 4326,
and applies it in-place before writing rows. The source SRS (as an
`EPSG:NNNN` string) is captured on the item's `source.sourceSrs`
provenance block so consumers can see where the data came from.
Files with no declared SRS are assumed to be 4326; reprojection is a
no-op when the source is already 4326.

**Clients reproject for display.** MapLibre renders 4326 GeoJSON in
Web Mercator (EPSG:3857) on the fly. We never store Web Mercator;
it's purely a rendering concern.

**What the portal does NOT do:**

  - Multi-SRID storage (one canonical SRID keeps the query layer
    simple and avoids transforming at every spatial filter)
  - Per-feature CRS (a feature inherits its layer's declared SRID)
  - Lossless preservation of the source projection through the
    ingest-query cycle (the original SRS is remembered as metadata
    only; features are stored in 4326)

**For callers extending the ingest pipeline:** follow the pattern in
`featureGeomJson()` in `apps/portal-api/src/ingest/ingest.service.ts`.
Read `layer.srs`, build `new gdal.CoordinateTransformation(src,
target4326)`, call `geom.transform(transform)` before `geom.toJSON()`.
PostGIS-side transforms use `ST_Transform`; we use them only for
display endpoints that want Web Mercator tiles, never for writes.

## Offline & Sync

The field app stores local state in SQLite (via Expo's SQLite or WatermelonDB).
Sync uses a pull/push delta model:

- **Pull**: client passes a `since` cursor; server returns changed features
  and form-submission rows.
- **Push**: client posts a batch of ops (`create`, `update`, `delete`) with a
  client-generated UUID; server reconciles and returns conflicts.

Conflicts are surfaced to the user as merge prompts in the app.

## Build & Deploy

- **Local dev**: `docker-compose up` starts infra; `pnpm dev` starts apps.
- **CI**: GitHub Actions runs lint, typecheck, test, build across workspace.
- **Prod (future)**: Container images pushed to GHCR; deployable via
  Docker Compose (single node) or Kubernetes (scale). No cloud lock-in.

## Non-goals (for now)

- Raster analysis / heavy geoprocessing (addressed via notebooks + tool-runner
  once phase 6/7 land; we won't build a bespoke geoprocessing engine)
- 3D scene services
- Native desktop client
