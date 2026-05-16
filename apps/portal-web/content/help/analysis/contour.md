---
id: analysis-contour
title: Contour
summary: Generate iso-lines (or iso-polygons) from a value column on a point or cell layer.
category: analysis
order: 100
complexity: advanced
tags:
  - analysis
  - derived-layer
  - contour
  - isolines
related:
  - items-derived-layer
  - analysis-fishnet
---

A **contour** step takes a layer of points (or fishnet cells) with
a numeric value and produces iso-lines (or iso-polygons) at
specified value intervals. The output represents lines of equal
value, like contour lines on a topographic map.

Use for elevation contours from a point cloud, signal-strength
isobars from a measurement grid, "minutes from the nearest
hospital" service zones.

## Inputs

- **Source layer** of points or fishnet cells.
- **Value field**: the numeric attribute to contour on.
- **Mode**:
  - **Iso-lines**. Output is line geometry at each level.
  - **Iso-polygons**. Output is filled polygon bands between
    levels.
- **Levels**: a list of values (`100, 200, 300, ...`) or an
 interval (`every 50`).
- **Smoothing**: how much to smooth the result. 0 = strict
 mathematical contours from the input grid; higher values
 produce visually smoother but slightly less precise lines.

## Output

A new layer of line (or polygon) geometry with attributes:

- `level`: the value of the contour line / lower edge of the
 polygon band.
- `level_top`: the upper edge (iso-polygons only).
- Aggregates from the original layer (mean, count) per band.

## How to use it on its own

1. Build a value layer first: typically points-with-a-value or
 a fishnet-binned summary.
2. New-item wizard → **Derived layer**.
3. Pick the value layer as Source.
4. Add a **Contour** step.
5. Pick the value field, mode, levels, and smoothing.
6. Save.

## Example: drive-time service zones

1. Start with a point grid (a fishnet's cell centroids).
2. For each cell, calculate drive time to the nearest hospital
 (an external routing tool, or a built-in approximation).
3. Contour on `drive_time_minutes`, iso-polygons, levels at
 `5, 10, 15, 20, 30`. Output is a polygon layer with bands
 you can render as a heatmap-style service-area map.

## Notes

- **Input density matters.** Coarse input grids produce jagged
 contours; fine grids produce smooth contours at higher cost.
 For elevation data, expect to use a point cloud or DEM-derived
 fishnet at meter-level cell size.
- **Edges are interpolated** linearly between adjacent input
 values. The contours are continuous within the input's
 coverage and stop at the input's bounding box.
- **Run cost**. Contour is expensive on large inputs. Run as
 a derived layer with scheduled refresh (nightly), not as an
 on-the-fly step.
