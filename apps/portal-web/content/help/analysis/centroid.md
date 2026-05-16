---
id: analysis-centroid
title: Centroid
summary: Replace each feature's geometry with a single point at its center.
category: analysis
order: 70
complexity: basic
tags:
  - analysis
  - derived-layer
  - centroid
related:
  - items-derived-layer
---

A **centroid** step replaces each feature's geometry with a
single point at the feature's center. Attributes are kept; only
the geometry changes from polygon (or line) to point.

Use when a downstream step or rendering wants point geometry:
labeling at a single anchor, clustering, point-symbol rendering
of a polygon layer, or input to a join that expects points.

## Inputs

- **Source layer**.
- **Centroid type**:
  - **Geometric centroid**. The math centroid. For convex
    polygons, this is the visual center. For irregular shapes
    (a U-shaped polygon), it can fall outside the polygon.
  - **Pole of inaccessibility**. The point inside the polygon
    that's furthest from any edge. Always inside. Slower to
    compute but visually nicer for labels.
  - **Bounding-box center**. The center of the polygon's bbox.
    Cheap; useful only when the polygon is roughly rectangular.

## Output

A new layer with point geometry. Attributes copied verbatim.

## How to use it on its own

1. New-item wizard → **Derived layer**.
2. Pick a non-point Source.
3. Add a **Centroid** step.
4. Choose the centroid type.
5. Save.

## Example

You have a parcel polygon layer and want a "parcel centroids"
point layer to use as the click target on a basemap-style map
(polygons read as decoration, points as the interactive layer).
Centroid step, type "Pole of inaccessibility" so the click point
is reliably inside the parcel.

## Notes

- **Centroid of a multipart geometry** is one point: the centroid
 of the combined geometry. Not one per part.
- **Linestrings have centroids too.** The midpoint along the
 line.
- **NULL geometry features** produce NULL output points and
 drop from rendering.
