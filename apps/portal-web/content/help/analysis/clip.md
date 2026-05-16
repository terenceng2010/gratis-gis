---
id: analysis-clip
title: Clip
summary: Keep only the parts of input features that fall inside a clip polygon. Cookie-cutter style.
category: analysis
order: 80
complexity: basic
tags:
  - analysis
  - derived-layer
  - clip
related:
  - items-derived-layer
  - items-geo-boundary
---

A **clip** step trims each input feature to the parts that fall
inside a clip polygon. Features entirely outside drop out;
features that cross the polygon boundary are cut.

This is the spatial "intersect with this shape" operation.
Cookie-cutter: hand it a parcel layer and a city boundary, get
back the parcels inside the city, with parcels on the edge
trimmed at the boundary.

## Inputs

- **Source layer**. Any geometry type.
- **Clip polygon**. One of:
  - A **Geo boundary** item (the most common case).
  - A single feature picked from another polygon layer.
  - A static polygon defined inline (paste GeoJSON).

## Output

A new layer with the source's schema. Each row's geometry is
`ST_Intersection(source.geometry, clip)`. Rows whose geometry
doesn't intersect the clip drop out entirely; rows whose
geometry is entirely inside come through unchanged.

## How to use it on its own

1. New-item wizard → **Derived layer**.
2. Pick a Source.
3. Add a **Clip** step.
4. Pick the **Clip polygon**.
5. Save.

## Example

You have a state-wide road network. You want just the segments
inside one county. Add a Clip step with the county's geo
boundary as the clip polygon. Output is the road segments
trimmed to the county line.

## Clip vs. spatial join with "within"

- **Clip** trims geometry; the output's geometry is the
 intersected piece. Roads sticking out beyond the county line
 are cut at the line.
- **Spatial join with within** keeps the whole input geometry
 if any part is inside the join polygon. Same roads, kept whole
 if they're "in" the county at all.

Pick clip when the geometry needs to stay within the polygon;
pick spatial-join-with-within when you want intact features
plus an attribute identifying which polygon they're in.

## Notes

- **Clip a polygon by a polygon** produces a polygon. Common
 case for "limit this layer to the project area".
- **Clip a line by a polygon** produces line segments at the
 boundary cut.
- **Clip a point by a polygon** is equivalent to a filter
 "points inside this polygon"; same result, both work.
- **The clip polygon's coordinate system** is reconciled
 automatically.
