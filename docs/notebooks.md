# Notebooks

GratisGIS ships a hosted Jupyter environment so users can do ad-hoc analysis,
automated reporting, and heavy geoprocessing in Python, directly against
portal data, respecting portal sharing rules.

This gives users the same kind of in-portal Python notebook workflow that
cloud GIS platforms offer, built on standard JupyterHub.

## Choice of tech

- **JupyterHub**: multi-user Jupyter server, 10+ years old, used by every
  major university, CERN, and enterprise. Supports OIDC natively via
  `oauthenticator`.
- **JupyterLab**: the modern notebook UI.
- **repo2docker / custom images**: reproducible per-org environments.
- **DockerSpawner (dev) / KubeSpawner (prod)**: launches per-user servers.

No alternative comes close in maturity or ecosystem support.

## Item integration

A notebook is an `Item` of type `notebook`:

- `data_json`:
  - `kernel`: `"python3"` (default), `"r"` (optional)
  - `image`: the docker image to spawn (defaults to `gratisgis/notebook:py-3.11`)
  - `schedule`: optional cron expression for scheduled runs
  - `outputs`: declared outputs (e.g. `{ type: 'dashboard-panel', itemId }`)
- `storage_ref`: MinIO key to the `.ipynb` file.

Sharing a notebook follows the normal Item rules. Executing a notebook
requires at least `view` permission; editing requires `edit`.

## Auth flow

1. User clicks "Open in Notebook" on an item in the portal.
2. Portal-web redirects to `/hub/spawn?itemId=<id>`.
3. JupyterHub, having already validated the user via Keycloak (same realm
   as portal-web), spawns a single-user server with env vars:
   - `GRATISGIS_API_URL=https://portal.local`
   - `GRATISGIS_ITEM_ID=<id>`
   - `GRATISGIS_TOKEN=<short-lived server-to-server token>`
4. The notebook image auto-opens the notebook fetched from MinIO.

## The `gratisgis` Python client

Shipped separately at `clients/python-gratisgis/` (future). Uses the
short-lived token to talk to `portal-api`:

```python
from gratisgis import Portal

portal = Portal()  # picks up env vars automatically
layer = portal.items.get("feature-service/<id>")
gdf = layer.to_geopandas()   # reads via portal-api with your permissions
```

All reads and writes pass through `portal-api`, so the sharing rules from
`data-model.md` are automatically enforced.

## Scheduled runs

The portal-api stores `schedule` on the notebook item. A small scheduler
service (Phase 6) uses `node-cron` to POST to the JupyterHub API:
`/hub/api/users/:user/servers` to spawn → execute (via `nbconvert`) →
terminate. Results can be saved back as a dashboard panel or a file item.

## Per-org environments

Each org can supply its own container image (pre-built by an admin) with
specific Python packages. Default image:

```
FROM jupyter/scipy-notebook:python-3.11
RUN pip install gratisgis geopandas rasterio shapely pyproj psycopg
```

## Security

- Single-user servers run as non-root in a read-only rootfs with a writable
  `/home/jovyan` volume.
- Egress is restricted to portal-api and allowlisted data sources.
- Server-to-server tokens are scoped to the specific notebook item and
  expire with the notebook server.
