---
id: what-is-gratisgis
title: What is GratisGIS
summary: GratisGIS is a self-hosted open-source portal for publishing maps, datasets, forms, and apps — the same shape as ArcGIS Online but with no commercial licensing.
category: getting-started
order: 10
complexity: basic
tags:
  - overview
  - intro
related:
  - creating-your-first-map
  - coming-from-arcgis-online
---

GratisGIS is a portal you run yourself.  It hosts the same kinds of
things ArcGIS Online does — maps, datasets, forms, dashboards, and
the apps that consume them — and it speaks the same workflows your
team already knows.  The differences are who owns the hardware and
what the license says.

## What it does

You upload data (Shapefile, GeoJSON, GeoPackage, KML), the portal
ingests it into PostGIS, and you can:

- **Style it on a map** — symbology, labels, filters, popups.
- **Share it** — to specific users, to your whole organization, or
  publicly with a link.
- **Edit it from the field** — the field PWA works offline, syncs
  back when it sees the network.
- **Collect new features through forms** — the form designer
  produces a layer-backed survey; submissions land as real features
  in your layer.
- **Publish a web app** — drag-and-drop builder with widgets
  (map, search, print, export, attribute table).
- **Analyze** — derived layers chain steps like filter, calculate,
  spatial join, group-by, buffer, contour.

## What it isn't

- **A SaaS.**  There's no `gratisgis.com` where you sign up and
  things appear.  You stand up the stack on your own infrastructure
  using the included Docker Compose file.
- **A re-skin of QGIS.**  The desktop app isn't in scope; GratisGIS
  is a portal, the same way ArcGIS Online is.
- **A drop-in clone.**  We deliberately don't use Esri's vocabulary
  where there's a clearer English word — *data layer* not *feature
  service*, *map* not *web map*, *contributor* not *publisher*.

## Who it's for

Small to medium organizations who:

- Want the AGO-shaped workflow but can't or won't pay AGO prices.
- Need to keep data on-premise for compliance or sovereignty reasons.
- Want to extend the system themselves (it's AGPL-3.0).

## Where things live

Every addressable thing in GratisGIS is an **item**.  Maps are items.
Data layers are items.  Forms are items.  Even basemaps and themes
are items.  This consistency means sharing, deletion, dependency
tracking, and search all work the same way regardless of what you're
looking at.

The full list of item types lives at **Reference → Item types**.
