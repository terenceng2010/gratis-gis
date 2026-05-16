---
id: widget-print
title: Print widget
summary: Generate a printable PDF (or PNG / JPEG) of the current map view, with title, legend, north arrow, scale bar.
category: web-apps/widgets
order: 30
complexity: basic
controls:
  - id: widget-print-toggle
    label: "Print tile in the widget palette"
tags:
  - widget
  - print
  - export
related:
  - items-web-app
  - items-report-template
---

The **Print** widget produces a printable image of the map's
current view. Configurable layout, paper size, title, and the
usual map-document trimmings (legend, north arrow, scale bar).

## What it produces

- **PDF** (default). Vector where possible (the legend, scale
 bar, text); raster for the map content. A4 / Letter / Tabloid
 sizes, portrait or landscape.
- **PNG / JPEG**. Raster output at a configurable DPI.

The output downloads directly; there's no print-server archive
unless you turn that on in widget config.

## What's in the output

By default:

- The **map** at its current view.
- A **title** (configurable; defaults to the map item's title).
- A **legend** (the visible layers' symbology).
- A **north arrow**.
- A **scale bar** (in the org's default units; configurable).
- An **attribution** strip at the bottom (the basemap's
 attribution, plus any per-layer attribution).

Toggle any of these off in widget config.

## Layouts

A **layout** is a template combining the map content with the
surrounding paper. Built-in layouts:

- **Map only**. Map fills the page; minimal chrome.
- **Map with sidebar**. Map takes 70%; sidebar has title,
 legend, scale.
- **Map with bottom strip**. Map dominates; thin strip below
 has title and scale.
- **Two-page**: map on page 1; legend + metadata on page 2.

Custom layouts (uploaded as a Print Template item) are a future
extension; not in v1.

## Widget config

- **Default layout** (one of the built-ins).
- **Default paper size** (A4 / Letter / Tabloid).
- **Default orientation** (portrait / landscape).
- **Title text or `{map.title}`** for auto-fill.
- **DPI** for raster output (default 96).
- **Allow user to override** any of the above (default: yes).

## Notes

- **Big maps print slowly.** A 1:1000-scale print of a 5km^2
 area at 300 DPI is a lot of tiles. Expect 10-30s for high-res
 PDFs.
- **External tile services** are honored. The widget queries
 the same tile URLs the on-screen map does; rate-limited
 providers can slow or fail the print.
- **For data-driven reports** (a per-feature inspection PDF,
 say), use a **Report template** instead. The Print widget is
 the right tool for "this map view, on paper."
