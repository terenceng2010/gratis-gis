---
id: analysis-dissolve
title: Dissolve
summary: Merge adjacent polygons that share an attribute value into one multipolygon per shared value.
category: analysis
order: 60
complexity: basic
tags:
  - analysis
  - derived-layer
  - dissolve
related:
  - items-derived-layer
  - analysis-group-by
---

A **dissolve** step merges polygons that share the same value of
a key field into one polygon (or multipolygon) per distinct value.
Boundaries between same-key polygons disappear; boundaries
between different-key polygons remain.

Use to clean up tile boundaries, simplify a parcel layer to a
land-use layer, or visualize "regions" computed from a finer
input.

## Inputs

- **Source layer** (must be polygon or multipolygon).
- **Key field** (optional). If set, polygons are dissolved per
 value. If omitted, every polygon dissolves into a single
 multipolygon.
- **Attributes to preserve**. By default the key field. You can
 add summary aggregates the same way as a group-by step
 (sum of an area field, count of input polygons per group).

## Output

One polygon (or multipolygon) per distinct key value. Schema is
the key field plus any preserved aggregates.

## How to use it on its own

1. New-item wizard → **Derived layer**.
2. Pick a polygon Source.
3. Add a **Dissolve** step.
4. Pick the **Key field**.
5. Save.

## Examples

- **Parcels to land-use polygons**. Source: parcel layer with a
 `land_use` field. Key: `land_use`. Output: one multipolygon per
 land-use category (one shape for "residential", one for
 "commercial", etc.).
- **Tile-boundary cleanup**. Source: a layer ingested from
 tiled-by-quad data where adjacent same-value cells should be
 one. Key: the cell value field. Output: clean polygons with
 no internal seams.
- **Single overall extent**. Source: any polygon layer. Key:
 omitted. Output: one multipolygon that's the union of every
 input. Useful as a quick "what's the total extent" reference.

## Dissolve vs. group-by with dissolve geometry strategy

Both can produce the same output. The differences:

- **Dissolve** is the simpler path; pick this when you only want
 the merged geometry plus the key.
- **Group-by** with `geometry strategy: dissolve` is the right
 path when you also want non-trivial aggregates (count, sum,
 average) computed alongside the dissolved geometry.

## Notes

- **Non-adjacent same-key polygons become multipolygons.** A
 layer where "residential" parcels are scattered across town
 produces a single multipolygon feature containing all of them.
- **Internal holes survive.** If the source polygons have rings
 that surround other-key polygons (a residential block around
 a commercial lot), the dissolve preserves the hole.
- **Slow on huge inputs.** Dissolving millions of polygons can
 take minutes; consider filtering first or running off-hours.
