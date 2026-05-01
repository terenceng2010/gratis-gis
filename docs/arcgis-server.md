# ArcGIS Server item type (design)

A new `arcgis_server` item type that points at an ArcGIS REST root
(e.g. `https://services.wvgis.wvu.edu/arcgis/rest/services`) and
lets users browse the folder / service tree to pull layers into
maps, dashboards, derived layers, and anywhere else `arcgis_service`
is consumed today.

The driver is a real workflow: an org has a partner ArcGIS Server
hosting dozens or hundreds of services across many folders.
Creating one `arcgis_service` item per service is friction; what
users want is to "add the server once, then browse it like a file
system." This is also the same shape Esri's webmap viewer uses for
"Add Layer from Connection" / "Add Layer from URL" against an
external server.

Status: design only. Implementation is phased; see Phases below.

## What this is not

- Not a replacement for `arcgis_service`. A user can keep adding
  individual `arcgis_service` items by URL when that's the right
  granularity (one well-known service that gets reused across
  many maps with curated layer config). `arcgis_server` is the
  catalog-level entry point.
- Not a new ArcGIS Online / Portal connector. Online and Portal
  expose `/sharing/rest/search` for item-level discovery on top
  of the same `/services` REST surface; this design covers only
  the `/services` tree, which is what ArcGIS Server, Online, and
  Portal all share. Org-level item search on Online / Portal is
  out of scope until a follow-up explicitly takes it on.
- Not a credential proxy redesign. The existing `item_credential`
  pipeline (#36) already handles Basic / token / OAuth for
  `arcgis_service`; we reuse it as-is, keyed by the server item's
  id.

## Data shape

`packages/shared-types/src/arcgis-server.ts`:

```ts
import type { ISODateString } from './ids';

export interface ArcgisServerData {
  version: 1;
  /**
   * REST root URL, e.g.
   * https://services.wvgis.wvu.edu/arcgis/rest/services
   * Trailing slashes are stripped on save.
   */
  url: string;
  /**
   * Optional human label for the connection. Defaults to the
   * server's reported `currentVersion` and host on probe.
   */
  description?: string;
  /**
   * Snapshot of the root catalog probe so the detail-page tree
   * can render instantly without re-walking on open. Folders and
   * services at the root only; deeper levels load lazily.
   */
  rootCatalog?: ArcgisServerCatalog;
  probedAt?: ISODateString;
  /**
   * Route every browse + layer-fetch call through the portal-api
   * proxy at /api/items/:id/proxy/... instead of hitting the
   * upstream URL directly (#36). True when the server item has
   * an associated ItemCredential.
   */
  requiresAuth?: boolean;
}

export interface ArcgisServerCatalog {
  /** Sub-folder names under the root, in upstream order. */
  folders: string[];
  /** Services at this level. Each entry includes name + service type. */
  services: ArcgisServerCatalogService[];
}

export interface ArcgisServerCatalogService {
  name: string; // e.g. "Planning_Cadastre/WV_Parcels"
  type: 'MapServer' | 'FeatureServer' | 'ImageServer' | 'GPServer' | 'GeocodeServer' | 'VectorTileServer';
}
```

The `rootCatalog` snapshot is a perf optimisation; the tree
browser walks deeper folders / services lazily and never persists
those probes (the catalog is cheap enough to refetch and we want
fresh data when the upstream changes).

## REST topology recap

ArcGIS Server REST is a JSON-over-HTTP tree:

```
GET /arcgis/rest/services?f=json
   -> { folders: [...], services: [{name, type}, ...] }

GET /arcgis/rest/services/<folder>?f=json
   -> { folders: [...], services: [...] }

GET /arcgis/rest/services/<folder>/<name>/MapServer?f=json
   -> { layers: [{id, name, ...}, ...], tables: [...], ... }

GET /arcgis/rest/services/<folder>/<name>/MapServer/<layerId>?f=json
   -> { type: 'Feature Layer'|'Table', geometryType, fields, ... }
```

Each level is one fetch. The tree browser walks lazily on expand
so a server with 200 services + 20 folders doesn't page-load 250
JSON docs.

## UI

### Item-detail page

Tree browser. Three columns of detail at most levels:

- **Tree:** folders, services, sublayers nested under a service.
  Each node is expandable; expansion fetches the next level's
  `?f=json` and caches in component state.
- **Selection detail:** when a leaf is highlighted, show the
  upstream description + sample fields + extent. Same probe call
  the existing `arcgis_service` detail page already does.
- **Add to map:** an "Add to map" CTA per leaf opens a small
  picker of the user's accessible maps (or "create new map") and
  appends the layer to the chosen one.

The picker is non-modal: tapping a folder expands it inline; the
selection detail panel updates when a leaf is focused; CTAs are
inline buttons rather than a confirm dialog.

### Add Layer dialog (consumers: maps, dashboards, derived layers)

A new "From server" tab alongside Portal / ArcGIS service / URL.

1. User picks a server item from a list (ItemPicker filtered to
   `type=arcgis_server`).
2. The dialog walks into a tree browser inline.
3. Multi-select on leaves (checkbox per layer); commit adds one
   `MapLayer` per selection.

Each created MapLayer has source:

```ts
{
  kind: 'arcgis-rest',
  url: 'https://services.wvgis.wvu.edu/arcgis/rest/services/Planning_Cadastre/WV_Parcels/MapServer',
  layerId: 0,
  serviceType: 'MapServer',
  sourceItemId: <server item id>, // dependency tracking
  ...(server.requiresAuth ? { proxyUrl: `/api/portal/items/${serverId}/proxy/Planning_Cadastre/WV_Parcels/MapServer` } : {}),
}
```

`sourceItemId` points at the server item, not at a per-service
item. This is the call: a single `arcgis_server` item is the
dependency carrier for every layer the user selects from it.
"Move server to trash" surfaces a dependents warning that lists
every map / dashboard / derived layer that uses any layer
sourced from this server, mirroring the existing arcgis_service
delete flow (#78).

### Wizard

`/items/new?type=arcgis_server`:

1. URL field, with a Probe button.
2. Probe hits `<url>?f=json`, validates the response is an
   ArcGIS Server catalog (has `folders` or `services` keys),
   reports back currentVersion + folder count + service count.
3. Auth section (reused from arcgis_service wizard, #14, #74,
   #76): None / Basic / ArcGIS token / OAuth.
4. Save: persists the item with `rootCatalog` populated from
   the probe response.

## Backend

### Probe endpoint

`POST /api/items/probe-arcgis-server { url, credential? } -> ArcgisServerCatalog`

Used by the wizard's Probe button before save. Validates the
response shape, fails fast on non-ArcGIS roots, returns the
top-level catalog. Same pattern as the existing
`/api/items/probe-arcgis-service` endpoint.

### Browse endpoint (proxied auth case)

`GET /api/portal/items/:serverId/browse?path=Planning_Cadastre`
returns the JSON catalog for that path. Required because
`requiresAuth: true` servers need the proxy to inject credentials;
public servers can be browsed direct from the client without this
endpoint.

### Layer-fetch proxy

The existing `/api/portal/items/:id/proxy` endpoint (#80) accepts
the residual path after the proxy prefix. For an arcgis_server
item, the residual is `<folder>/<name>/MapServer/<layerId>/query`
etc. -- no schema change, just route the same proxy at the new
item type. The credential lookup keys by `:id`, which is the
server item.

### Dependency tracking

`/api/items/:id/dependencies` already walks every map's layers
for `source.kind === 'arcgis-rest' && source.sourceItemId === :id`.
Server items get the same walk for free; nothing to add.

## Permission model

- Read access to the server item lets the user browse + add
  layers. Standard share / item-level permission applies.
- Write access lets the user edit URL / credentials.
- Server access does NOT confer access to upstream services that
  require their own auth -- the proxy resolves the configured
  credential, period. If the upstream has per-service ACLs, those
  enforce at fetch time and we surface 401 / 403 to the consumer.
- One credential per server item. Mixed-auth orgs add multiple
  server items, one per credential bucket.

## Phases

### Phase 1: server item + tree browser + Add Layer "From server" tab

- shared-types: `arcgis-server.ts` (data shape, helpers).
- portal-api: `probe-arcgis-server` endpoint, browse passthrough,
  ItemsService recognition of the new type, proxy route mapping.
- portal-web: wizard, item detail page with lazy tree, Add Layer
  dialog "From server" tab, dependency-display passthrough.
- Output: arcgis-rest MapLayer entries with proxyUrl + sourceItemId
  pointing at the server item. No per-layer item minted.

### Phase 2: reuse across consuming surfaces

- Dashboards Add Layer flow, derived-layer source picker,
  anywhere `arcgis_service` is referenced.
- Search across the tree (filter the catalog at every level).
- Cache layer descriptors after first probe per (server,
  service, layer) so reopening a tree node doesn't refetch.

### Phase 3: discovery polish

- Recently-used tree nodes section above the full tree.
- Bookmarked layers (per-user "favorite this layer" so it shows
  up at the top of the tree).
- Diff vs last probe -- highlight new / removed services since
  the last visit.

## Out of scope (or later)

- ArcGIS Online / Portal item search via `/sharing/rest/search`.
  That's a separate item type ("arcgis_portal"?) sharing the
  same proxy + credential plumbing. Add when there's a real org
  asking for it.
- Promoting a single layer to its own `arcgis_service` item.
  Worth a follow-up for users who want to pin a specific layer
  config (label rename, visible toggle) and reuse it across many
  maps. Out of Phase 1 to keep scope tight.
- Rate-limiting / connection throttling on the proxy. The
  existing arcgis_service proxy doesn't throttle; if abuse
  becomes a concern across all credentialed item types, that
  fix lives at the proxy layer, not at the server item.

## Open questions

1. Should "Open service page" links on layers added from a
   server take the user to the upstream `?f=html` endpoint, or
   surface our own service-detail mini-page? The arcgis_service
   item type goes to the upstream; consistency suggests doing
   the same here, but there's no item-page anchor for a
   server-derived layer. Probably: link to the server item's
   detail page with the relevant tree node pre-expanded.

2. How does the tree browser handle a server with hundreds of
   services in a single folder? Plain virtualised list at first;
   add filter input (#3 in Phase 2) once we have a real example.

3. ArcGIS GeocodeServer + GeoprocessingServer sit alongside
   feature / map services in the catalog. We probably want to
   show them but disable the "Add to map" CTA (a geocoder is
   not a layer). The catalog snapshot already knows the type;
   render gating is straightforward.

## Related work

- #36, #80: secured external services + credential-aware proxy.
  Reuse end-to-end.
- #76: ArcGIS token auto-exchange. Apply unchanged when a server
  item carries Basic creds and the upstream wants a token.
- #94: arcgis_service feature-extent probing during recompute.
  Server items don't need this directly, but the layers added
  from them go through the same recompute pass via their
  arcgis-rest source.
- #180 (Geocoder as item type): same proxy + credential pattern.
  Worth landing both in the same sprint so the proxy gains all
  the new item types it'll need to recognise at once.
