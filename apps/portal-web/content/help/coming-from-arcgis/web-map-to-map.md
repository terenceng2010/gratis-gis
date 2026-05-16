---
id: coming-from-arcgis-web-map
title: Web map to map
summary: Import an ArcGIS Online web map JSON into a GratisGIS map. Layers, basemap, viewport, and styling come over.
category: coming-from-arcgis
order: 30
complexity: intermediate
tags:
  - migration
  - web-map
  - map
related:
  - items-map
  - coming-from-arcgis-feature-service
  - coming-from-arcgis-terminology
---

An AGO **web map** maps onto a GratisGIS **map**. Same idea:
references to layers, a basemap, a viewport, optional bookmarks.
The format is different, but the converter handles most of it.

## What you need first

- The web map's **JSON description**. From AGO, the API endpoint
 `/sharing/rest/content/items/<item-id>/data` returns it.
 (Browser: open the item, choose **Item information → JSON**.)
- The **GratisGIS equivalents** for the layers the web map
 references. Either:
  - You've already converted each feature service to a data
    layer (Path A on the previous page), OR
  - You created **ArcGIS service** items for them (Path B), OR
  - A mix.

## Running the importer

1. Create a new map in GratisGIS (or open an existing empty one
 you want to populate).
2. In the map builder, open **Import web map JSON**.
3. Paste or upload the AGO web map JSON.
4. The importer matches each AGO layer reference to a GratisGIS
 item by URL or by the title hint. Unmatched layers show in a
 "needs binding" panel; pick the right data layer or ArcGIS
 service item for each.
5. Click **Apply**.

## What carries over

- **Layer references.** Each AGO layer becomes a map layer in the
 new map, pointing at the bound GratisGIS item.
- **Renderer / symbology.** Simple, unique-value, and class-break
 renderers map onto GratisGIS Simple, Categorical, and Graduated
 symbology. Heatmap → Heatmap. Dot density → Categorical
 fallback (not exact today).
- **Labels.** Label expression and placement are converted; the
 expression dialect is reformatted into the GratisGIS label
 expression syntax.
- **Pop-up config.** Title template and field list come over;
 custom Arcade in the popup is dropped with a warning (see
 below).
- **Basemap.** Mapped to a basemap item by URL or style. If no
 matching basemap exists in this portal, the importer offers to
 create one.
- **Viewport.** Center, zoom.
- **Bookmarks.** Each AGO bookmark becomes a saved viewport entry.

## What does NOT carry over

- **Arcade expressions.** Both in popups and as label expressions,
 Arcade is dropped. The importer surfaces every Arcade snippet
 as a warning so you can rewrite the equivalent in GratisGIS's
 expression language. They're not far apart syntactically.
- **Time slider config** beyond a basic "field X is time."
- **Layer effects** (bloom, blur, hillshade) that don't exist on
 the GratisGIS side.

The importer shows a list of warnings before applying. Resolve
each (or accept the loss) before clicking Apply.

## After import

- **Save**. The new map's first save is its own observation; the
 import isn't an automatic save.
- **Verify**. Open the map, confirm each layer draws, confirm
 popups read sensibly.
- **Re-share**. Sharing isn't carried over. Set it deliberately
 on the new map item.

## See also

- **Map**. The native item type docs.
- **Feature service to data layer**. Get the underlying layers
 here first.
