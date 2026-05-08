# Notebooks (deferred to v2)

GratisGIS does **not** ship a hosted Jupyter environment in v1. The
`notebook` item type was removed in the engine pivot (Phase 2.5,
2026-05-07): the maintenance cost of running multi-user Jupyter
(JupyterHub, KubeSpawner, per-org images, secret rotation, kernel
isolation) was a poor fit for a single-developer pre-v1 project, and
the same use cases are covered by either the visual `tool` item type
or by users connecting their own external Jupyter to the portal.

## What replaces it

### Reusable computation -> tool items

The `tool` item type covers the "reusable analytical step" use case
that originally motivated having notebooks as items. Tools are
visual, parameterised, and live inside the portal's sharing model;
they wrap PostGIS / engine queries with a typed input/output
contract. See `docs/tool-builder.md` for the surface.

### Ad-hoc analysis -> bring-your-own Jupyter

The portal exposes a read-only API per data layer
(`/api/items/<id>/features` for current truth, plus the engine's
observation log endpoints once Phase 3 lands). Users connect their
own Jupyter / VS Code / RStudio with a personal access token;
geographic-share-limited reads are still enforced server-side, so
the user only sees data they have access to in-portal.

A short BYO-Jupyter starter notebook lives in
`scripts/byo-jupyter/`: it wires a personal access token, fetches a
data layer's GeoJSON, joins it with a derived layer, and pushes
results back as a tool run. v2 may bundle this as a downloadable
template; v1 leaves it as a manual setup.

## Why deferred (and not deleted)

The architecture doc records `notebook` as an open v2 candidate.
JupyterHub remains the obvious add-on if user demand justifies the
operational cost, and the engine's read-only API is the right
substrate to layer it on. Re-adding the item type later is a
two-line schema change plus a UI surface; nothing in the engine
foundation forecloses it.
