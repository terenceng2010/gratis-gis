# GratisGIS Roadmap

A phased delivery plan. Each phase is intended to be independently useful and
demo-able; phases intentionally build on one another.

---

## Phase 0: Scaffolding (now)

- [x] Project charter, architecture, roadmap
- [x] Monorepo (pnpm + Turborepo)
- [x] Docker-compose infra (Postgres/PostGIS, Keycloak, MinIO, pg\_tileserv)
- [x] Shared packages skeleton
- [x] CI pipeline
- [ ] Local dev loop: `pnpm dev` brings up everything

## Phase 1: Portal MVP (pillar 1) 🎯

Goal: a usable portal with auth, items, and sharing. This is the bedrock.

- [ ] Keycloak realm + JWT verification in portal-api
- [ ] Prisma schema for users, groups, items, item\_shares, orgs
- [ ] `/users/me`, `/groups`, `/items` REST endpoints
- [ ] Sharing permission checks (private → groups → org → public)
- [ ] portal-web: sign-in, my items, item detail, sharing UI
- [ ] Group management UI (create group, invite, roles)
- [ ] Search + filter on items

**Exit criteria:** two users in two groups can each create items, share with
their group, and see each other's shared items (but not private ones).

## Phase 2: Web Maps (pillar 2)

- [ ] Feature-service endpoint backed by PostGIS
- [ ] Upload GeoJSON / Shapefile / GeoPackage → creates a feature-service item
- [ ] pg\_tileserv integration with per-layer permission proxy
- [ ] Web-map item type (JSON: basemap + layer refs + styling)
- [ ] Map viewer in portal-web using MapLibre GL
- [ ] Simple map authoring UI (add/remove layers, style pop-ups)

**Exit criteria:** upload a GeoJSON, it becomes a shareable layer, and a
saved web-map renders it in the portal.

## Phase 3: Form Designer + Data Collection (pillar 4) 🔥

This is the highest-differentiation pillar. We consolidate Survey123 +
Field Maps into one experience.

- [ ] Port Survey123-Designer form-builder UI into `apps/form-designer`
- [ ] `packages/form-schema` finalized (JSON Schema + custom widget types)
- [ ] `packages/form-renderer`. React components rendering a form schema,
      isomorphic across web and React Native
- [ ] `apps/field-app` (Expo). browse items, download offline, fill forms,
      capture points/lines/polygons, photo & sketch capture
- [ ] Delta sync engine (WatermelonDB + conflict UI)
- [ ] Submissions stored as rows in PostGIS feature tables

**Exit criteria:** design a form on the web, deploy it, collect 10 records
offline on a phone, come back online, sync cleanly.

## Phase 4: App Builder (pillar 3)

- [ ] Widget framework (widget manifests, drag/drop canvas)
- [ ] Core widget set: Map, List, Chart, Filter, Text, Image, Attribute Table
- [ ] Configuration panels per widget
- [ ] Preview + publish to a web-app item
- [ ] Hosted runtime at `/apps/:slug`

**Exit criteria:** configure a 3-widget app (map + list + filter) against
a feature service without writing code, and publish it.

## Phase 5: Reports (pillar 5)

- [ ] Report template item type (markup + placeholders + chart specs)
- [ ] Report runner (render to HTML, PDF, docx)
- [ ] Scheduled report delivery via email
- [ ] Dashboard item type (live charts over feature data)

## Phase 6: Notebooks (pillar 6)

- [ ] JupyterHub deployment (docker-compose for dev, Helm chart for prod)
- [ ] Keycloak OIDC plugged in as JupyterHub's authenticator
- [ ] Notebook item type: portal stores the `.ipynb`, launches it in the hub
- [ ] `gratisgis` Python client lib for portal auth, item CRUD, PostGIS reads
- [ ] Scheduled notebook runs (cron-like, results saved back as items)

**Exit criteria:** from the portal, a user opens a notebook, runs a query
against a shared feature service, saves the resulting chart as a dashboard
panel, all without re-authenticating.

## Phase 7: Tool & Widget Builder (pillar 7)

- [ ] `apps/tool-builder`. React Flow canvas for authoring node graphs
- [ ] Catalog of node types: spatial ops (buffer/intersect/dissolve), SQL,
      HTTP fetch, form-submission filter, chart spec, map-layer output
- [ ] `apps/tool-runner`: server-side executor that materializes a graph
      into a job (uses PostGIS where possible, turf.js otherwise, escape
      hatch to a notebook kernel for Python ops)
- [ ] Tool item type; tools are runnable standalone and embeddable as a
      custom widget in the app builder (phase 4)

**Exit criteria:** visually build a "buffer + intersect" analysis that takes
two feature-service inputs, saves results to a new feature service, and
publish the same graph as a draggable widget in the app builder.

## Phase 8: Hardening

- [ ] AuthZ policy tests
- [ ] Load tests for tile serving
- [ ] Backup / restore tooling
- [ ] Migration guides from ArcGIS Online exports

---

## Milestone Cadence

Rough estimate for a small team (1–3 full-time engineers):

| Phase | Duration |
| --- | --- |
| 0 – Scaffolding | 1–2 weeks |
| 1 – Portal MVP | 4–6 weeks |
| 2 – Web Maps | 4–6 weeks |
| 3 – Forms + Field App | 8–12 weeks |
| 4 – App Builder | 6–10 weeks |
| 5 – Reports | 4–6 weeks |
| 6 – Notebooks | 3–4 weeks (integration-heavy, less new code) |
| 7 – Tool & Widget Builder | 6–10 weeks |

Solo effort: roughly 3–4× these numbers. This is a genuinely big project;
the phase boundaries exist so each ship brings real value.
