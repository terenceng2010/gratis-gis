# Item type guidance

When to introduce a new top-level `ItemType`, when to fold something
into an existing type as a template/variant, and what's the line
between the two. Written when we consolidated `editor` into
`web_app` (#258, 2026-05-03) and noticed the same question would
come up the next time someone reached for a new app surface.

## The default: app-shaped surfaces are `web_app` templates

If you're building something users would describe as "an app that
runs on top of an item", the default is to add it as a `web_app`
template variant rather than a new top-level item type. So far that
covers:

- **Editor** (`web_app` with `data.template === 'editor'`) — adds
  drawing/editing tools on top of one or more `data_layer` targets.
  Folded in via #258.
- **Dashboard** (planned) — read-only KPI / chart layout on top of
  one or more `data_layer` items. When it lands, it lands as a
  `web_app` template, not its own type.
- **Survey-response viewer** (planned) — opens onto a `form` item's
  submission collection. `web_app` template.
- **Story map / scrolly map** (planned) — narrative layout on top of
  one or more `map` items. `web_app` template.

The shared parts of the `web_app` shape (title, description, sharing,
folder membership, lifecycle) come for free. Only the
template-specific config lives in `data.config`.

## The exception: dedicated `ItemType` when the data shape is genuinely different

A new top-level `ItemType` is justified when **the data shape is
substantially different from anything else**, not just when a new
piece of UI happens to need a home. Examples that earned their own
type:

- **`form`** — owns a versioned schema, a submission collection, and
  an offline-capable runtime. Not a templated app on top of someone
  else's data; it IS the data.
- **`data_layer`** — owns PostGIS-backed feature tables, an
  ingest/replace pipeline, and per-layer indexing. Schema and
  storage are the whole point.
- **`data_collection`** — pairs a `form` with a `map` for offline
  field deployments. Has its own lifecycle (deployment manifest,
  per-device cache, queue manifest). Distinct enough that "Form +
  Map = Deployment" reads better than "Web app with template =
  data_collection".
- **`map`**, **`pick_list`**, **`geo_boundary`**, **`folder`** —
  each owns a domain-specific data shape that other items reuse.

The litmus test:
1. Does the type need a Prisma column or table not on `Item`?
   If yes, it's its own type.
2. Does the type carry its own per-row data outside `Item.data`?
   If yes, it's its own type.
3. Does the type have specialized server endpoints beyond the
   standard `Item` CRUD? If yes, it might be its own type.
4. Otherwise, it's a `web_app` template. Use a dedicated route
   (`/items/[id]/web-app/<template>/`) and a `data.config` shape
   for the template-specific bits.

## The editor case (#258)

Editor passed test #1 (no Prisma changes needed) and test #2 (its
data lives in `Item.data` like every other item) but had specialized
server endpoints (editor-policy enforcement, dependency-access
matrix). When this judgment call came up, we decided the endpoints
weren't a strong enough reason — the type guard inside an endpoint
can switch on `(item.type === 'web_app' && data?.template ===
'editor')` instead of `item.type === 'editor'` and do the same
work. So editor folded in.

If a future template grows server endpoints that are genuinely
distinct from web_app's general handling, that template can still
get its own controller without becoming a top-level type — the
controller path can be `web-app/<template>/...` rather than
`<template>/...`.

## Discoverability

When a `web_app` covers many templates, "show me my editors" still
needs to work. Two ways the items list filter handles this:

1. **Type chips** stay simple: `web_app` is one chip. No
   sub-chip-explosion.
2. **Template facet** appears as a secondary filter when `web_app`
   is selected. Templates are discoverable but stay out of the way
   when not needed.
3. **Smart folders** (#38) accept a `template` clause subject so
   "all editor items owned by me" is one saved query.

## Migration pattern (for the next consolidation)

When you fold an existing top-level type into a `web_app` template:

1. **Don't drop the enum value** in the same release as the data
   migration. Keep it as deprecated so any in-flight API consumers
   don't crash. Drop it in a follow-up release once you're confident
   the migration covered everything.
2. **Write the type guard helper** (`isEditorItem(item)` style) and
   replace every literal `item.type === 'editor'` with it. The helper
   reads `(type === 'web_app' && data?.template === 'editor') ||
   type === 'editor'` during the deprecation window, then collapses
   to the first half once the enum value is gone.
3. **Use `IF NOT EXISTS`-style idempotency** in the Prisma migration
   so re-running the migration on an already-converted database is
   safe.
4. **Do the URL move (if any) in a separate slice** from the
   data-shape change so a regression in one is easier to bisect.
5. **Update the create wizard** to bias new items toward the new
   home, but keep a quick-pick that still says "Editor" so the
   user-facing word doesn't change.
