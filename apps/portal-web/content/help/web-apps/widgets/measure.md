---
id: widget-measure
title: Measure widget
summary: A toolbar tool that lets viewers measure distances, areas, and coordinates on the map.
category: web-apps/widgets
order: 70
complexity: basic
tags:
  - widget
  - measure
related:
  - items-web-app
---

The **Measure** widget adds a small toolbar with measure tools:
distance (along a drawn line), area (within a drawn polygon),
and a "what's the coordinate of this point" lookup.

## What it shows

A toolbar with three modes:

- **Distance**. The user clicks to start a line; subsequent
 clicks add vertices. Live readout shows total length. Double-
 click to finish.
- **Area**. The user clicks to draw a polygon; live readout
 shows area and perimeter. Double-click to close.
- **Coordinate**. Single click on the map; readout shows lat/lon
 in the configured format.

## Widget config

- **Default units**:
  - Distance: meters, feet, miles, kilometers, nautical miles.
  - Area: m^2, ft^2, acres, hectares, mi^2.
- **Show secondary unit** (default: off). When on, the readout
 shows both meters and feet (or whichever pair).
- **Coordinate format**:
  - Decimal degrees.
  - Degrees-minutes-seconds.
  - UTM (configurable zone or auto-detected).
  - MGRS.
- **Snap to features** (default: off). When on, line/polygon
 vertices snap to the nearest visible feature vertex within
 a few pixels.

## Geodesic vs. planar

Measurements are **geodesic** by default: the portal computes
on the curved earth surface, so a 1km measurement at the
equator and one at 60° latitude are both 1km on the ground.

The widget config has a "Planar" mode for when the user
explicitly wants pixel-distance measurements (useful for
small-extent maps where the difference doesn't matter and
geodesic adds a small computational cost).

## Notes

- **Measurements aren't saved.** They're ephemeral overlays;
 closing the tool clears them. For a permanent measured
 polygon, draw it as a feature in a data layer instead.
- **Precision**. Distances are reported to 1m / 1ft; areas to
 1m^2 / 1ft^2. Increase precision in the widget settings if
 you need finer.
