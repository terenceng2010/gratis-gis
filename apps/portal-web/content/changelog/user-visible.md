# What's new

User-visible changes shipped to GratisGIS. Plain-English summaries
only; one entry per notable feature. Add new entries at the top.

Format: `## YYYY-MM-DD — Short feature name` on one line, then one
short paragraph of plain-English description on the next line.

This file is loaded by the public landing page at runtime, so
keep entries short and accessible. Anything that reads like a
release note ("Refactored the X service") doesn't belong here.

<!-- entries below this line are surfaced on the public landing page -->

## 2026-05-31 — Print scalebar + north arrow read the actual map
The scalebar on a print layout now computes its bar length from
the bound map's center latitude and zoom and labels itself with
a real distance (m / km / ft / mi) rather than a placeholder.
The north arrow rotates to keep north up regardless of how the
map is oriented. ArcGIS REST and live PostGIS data layers now
paint into the print PDF too, alongside data-layer sources.

## 2026-05-31 — Sharper print maps + real layer-bound legend
The print pipeline now renders maps inline rather than via an
embedded frame, so vector layer data paints as path primitives
in the PDF instead of an embedded raster. Layer-bound legend
elements show the bound map's actual visible layers, with a
swatch per layer that matches the layer's style. Private maps
and private templates render too (previously the preview only
worked for publicly-shared items).

## 2026-05-31 — Print PDFs render the real layout
The server-side print path now reads the print template's actual
layout: title text and parameter bindings, image elements, lines
and rectangles, scalebars and north arrows all render at the
right paper size, with the right fonts and colors, in the right
positions. Map frames embed the calling map; the layer-bound
legend lands next.

## 2026-05-31 — Better-quality print PDFs
The print pipeline now has a server-side render path. Instead of
relying on the browser's print dialog, the portal renders the
layout in a headless browser running on the server and returns a
vector-fidelity PDF. Text stays selectable, lines stay vector,
multi-page layouts come out clean. Phase 2.1 finishes wiring the
existing print designer's layout elements into the new pipeline.

## 2026-05-31 — Multi-language foundation in place
The plumbing for translating the portal into other languages
just landed. Five locales are on the supported list (English,
Spanish, Portuguese for Brazil, French, German); for now the
non-English catalogs are empty and fall back to English, but
the runtime, the Accept-Language negotiator, and the
contributor guide are ready. Help us translate at
CONTRIBUTING-TRANSLATIONS.md.

## 2026-05-31 — Point a map at a live PostgreSQL + PostGIS database
A new connection type lets you register a live PostGIS database
and render its tables on maps without copying the rows in. Every
viewport move issues a bounding-box SELECT directly against your
database; the GiST index does the spatial work. The password is
stored encrypted and never reaches the browser. Bring your own
warehouse, no data migration needed.

## 2026-05-31 — Print this map, one click away
A Print button in the map editor opens a chooser: create a new
print layout pre-bound to this map, or pick an existing layout
to print with. The Map, Legend, Scalebar, and North arrow auto-
bind to the calling map so you skip the manual wiring. Higher-
fidelity PDF rendering lands next.

## 2026-05-31 — Workflows: analysis as a connected graph
The analysis engine now understands a workflow as a graph of
connected steps, not just a straight line. One result can flow
into multiple downstream steps, and multiple results can
converge. Existing tools keep running unchanged; new node
kinds and the visual graph editor land in the next phase.

## 2026-05-30 — Plug your portal into AI assistants
A small MCP server ships with the project so MCP-compatible
desktop AI tools can read your items and layer features
directly. List items, fetch metadata, read features as
GeoJSON, all gated by your normal portal permissions.

## 2026-05-30 — Smart CSV uploads
Drop a CSV with latitude and longitude columns and get a
mapped layer in one step. Sloppy column names like "LAT" or
"x_coord" are auto-detected. Tab and semicolon delimiters,
UTF-8 BOM, and European decimal commas all just work.

## 2026-05-30 — See who else is on the map
Avatar chips at the top of the map canvas show every viewer
who currently has the map open. Each person's cursor renders
as a colored arrow with their name so a teammate over a video
call can point at something without giving you coordinates.

## 2026-05-30 — Conversations on a map
Threaded comments scoped to a map. Open a thread, reply,
resolve when answered. Anyone who can view the map can join
the conversation. Comment authors can edit their own posts
for 15 minutes; map editors can clean up at any time.

## 2026-05-30 — Map markup and redlining
Anyone who can view a shared map can drop colored pins on it
to flag issues, without needing edit permission. Each
reviewer's markup gets its own distinct color so multiple
people's notes don't blur together. The classic "manager
opens the map, flags three parcels, ships the URL back to
the team" workflow.

## 2026-05-24 — Query OpenStreetMap from your tools
Build tools that ask OpenStreetMap for things in the real world.
Pick "Gas stations" or "Restaurants" (or any of ~1,600 other
categories), draw an area on the map, optionally add a filter
like "brand = Citgo", and matching features show up on top of
your map with proper attribution. No coding required.

## 2026-05-24 — Custom tools for web apps
Build your own buttons inside a web app that run on-demand actions on
the map. A "Select By Location" starter is ready to drop in: click it,
draw an area, pick a relationship, and the matching features light up.

## 2026-05-24 — Better map symbols
Choose from 150+ professional point symbols (or upload your own SVG).
Line and outline styles now support dashes, dots, and rounded corners
to match the look of paid GIS tools.

## 2026-05-22 — Smoother imports from ArcGIS Online
Pull layers, maps, and files over from AGO with live progress
feedback and a cancel button. Large org migrations no longer time
out silently.

## 2026-05-13 — Designer-driven thumbnails
Item thumbnails are built from a small visual designer you can
re-open and tweak any time. Renaming or changing colors regenerates
the thumbnail automatically.

## 2026-05-08 — Save and load Web Map JSON
Export a map's full setup (layers, styling, viewport) as a standard
JSON file. Import the same file later or share it with someone else
to reproduce the map exactly.
