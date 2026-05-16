---
id: analysis-fishnet
title: Fishnet
summary: Generate a regular grid of square (or hex) polygons over an extent. The starting layer for any "binned-by-cell" analysis.
category: analysis
order: 90
complexity: intermediate
tags:
  - analysis
  - derived-layer
  - fishnet
  - grid
related:
  - items-derived-layer
  - analysis-spatial-join
  - analysis-group-by
---

A **fishnet** step generates a regular grid of polygon cells over
an extent. Each cell is a polygon feature with row/column attributes.
The output is a starting layer; pair it with a spatial-join and
group-by to produce a heatmap-style summary "X per cell".

## Inputs

- **Cell shape**: square or hex (hexagonal).
- **Cell size**: edge length in meters (or feet, or miles).
- **Extent**: one of:
  - A **Geo boundary** item.
  - The bounding box of another layer.
  - A manual bounding box.
- Optional **clip to a polygon**: instead of filling the bounding
 box, generate only cells that intersect a polygon. Produces a
 grid shaped like the polygon.

## Output

A polygon layer with one row per cell. Schema:

- `row`, `col` (or `i`, `j` for hex): cell coordinates.
- `area_m2`: the cell's geometric area (in m^2).
- `bbox`: the cell's bounding box.

## How to use it on its own

1. New-item wizard → **Derived layer**.
2. Add a **Fishnet** step (no Source: fishnet creates its own
 input).
3. Pick shape, size, extent.
4. (Optional) Pick a clip polygon.
5. Save.

## Example: incident density by 500m cell

1. Fishnet over the city's geo boundary, square cells, 500m edge.
2. Spatial join: target = fishnet, join = incidents,
 predicate = contains, cardinality = one-to-many.
3. Group by: keys = `row`, `col`. Aggregate = `count(*) as
 incident_count`. Geometry strategy = `first` (the fishnet's
 cell geometry).
4. Symbology: Graduated on `incident_count`.

The result is a heatmap-style choropleth without the rendering
expense of a true heatmap.

## Hex vs. square

- **Square** cells are easier to read off a printed legend and
 align with city-grid neighborhoods nicely.
- **Hex** cells have the same neighbor distance in every
 direction (good for distance-decay analysis) and visually
 read smoother for density.

Use whichever fits the audience.

## Notes

- **Cell counts grow fast.** A 250m grid over a 50km x 50km
 county is 40,000 cells; a 100m grid is 250,000. Watch the
 estimated row count before saving.
- **Cells outside the clip polygon drop entirely.** A hex
 fishnet clipped to an irregular boundary doesn't carry "edge
 cells" that are mostly outside; they're trimmed to nothing
 and dropped.
- **Cell size is in projected units.** The portal computes in a
 local equal-area projection so "500m cells" are actually 500m
 on the ground.
