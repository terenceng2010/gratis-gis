---
id: items-tile-layer
title: Tile layer
summary: An item that wraps a pre-rendered tile container (PMTiles), uploaded once and served by range request.
category: items
order: 120
complexity: intermediate
tags:
  - tile-layer
  - item-type
  - tiles
  - pmtiles
related:
  - items-basemap
  - items-data-layer
---

A **tile layer** is an item that wraps a single pre-rendered tile
container: a PMTiles file uploaded into MinIO. Use for basemaps
backed by your own cache, big raster overlays that would be too
heavy to render from features on the fly, or vector tiles
generated from a curated dataset.

## At-rest format: PMTiles

The portal stores tile-layer bytes as **PMTiles** regardless of
what you upload. PMTiles is an open spec (CC0): a single file with
an embedded directory, range-readable over HTTP, no SQLite open
or per-tile server compute. MinIO range-serves the file directly;
MapLibre's pmtiles protocol plugin reads it with range requests
from the browser.

We unify on PMTiles at rest because the serving path (zero
per-tile compute) only works for PMTiles. MBTiles + zipped XYZ
ingestion exists for user convenience; we convert them on upload.

## Accepted upload formats

- **`.pmtiles`**: pass-through, no conversion.
- **`.mbtiles`**: converted to PMTiles via the `pmtiles` CLI on
 upload. The SQLite directory is read once and re-packed.
- **`.zip` of an XYZ tile directory** (`{z}/{x}/{y}.{ext}`)
. Unzipped, then `pmtiles convert <dir>` walks the structure
 and packs the archive.

The portal records the original format and filename on the item
so you can see what you uploaded vs. what's stored.

## TPK / TPKX

Esri's TPK and TPKX bundles aren't accepted at upload today. They
wrap PNG/JPG tiles in a custom index format that needs its own
extraction pipeline. Documented as future scope, not blocked.

## Raster vs. vector

PMTiles can store either. The portal reads the file header at
upload to determine which kind you have. Raster tile layers
become raster MapLibre sources; vector tile layers become vector
sources and can be styled like any other vector data.

## Using a tile layer as a basemap

The detail page surfaces a **Use as basemap** action that pre-fills
a new basemap item with `kind: tile-url` and the tile layer's
internal URL (`pmtiles://<api-base>/api/portal/tile-layer/<id>/file`).
Other tile-URL basemaps still work for external XYZ services.

## What's stored on the item

- Storage key and public URL of the PMTiles file in MinIO.
- File size, original size (before conversion), conversion time.
- Min zoom, max zoom, bounds, suggested center.
- Tile content type (mvt, png, jpg, webp, avif).
- Attribution string from the PMTiles header (if set).

## Notes

- **No re-tile on data change.** Tile layers are pre-rendered.
 Updating the source means uploading a new PMTiles file.
- **Bounds enforce themselves.** Tiles outside the bounding box
 in the PMTiles header simply don't exist; MapLibre stops asking
 for them.
