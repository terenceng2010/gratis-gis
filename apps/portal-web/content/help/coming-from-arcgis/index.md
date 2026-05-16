---
id: coming-from-arcgis-overview
title: Coming from ArcGIS Online
summary: Orientation pages for ArcGIS Online and ArcGIS Pro users moving to GratisGIS. Same workflows, different names.
category: coming-from-arcgis
order: 0
complexity: basic
tags:
  - migration
  - arcgis-online
  - terminology
related:
  - coming-from-arcgis-terminology
  - coming-from-arcgis-feature-service
  - coming-from-arcgis-web-map
---

If you're coming to GratisGIS from ArcGIS Online or ArcGIS Pro,
most of the workflow is going to feel familiar. You create items.
Items have an owner and sharing tiers. Maps reference layers.
Layers carry symbology. You can publish web apps from a map. There
are widgets. Dashboards roll up indicators. Survey-style forms
collect new features. The big surfaces line up.

What's different:

- **Vocabulary.** We deliberately don't use Esri's specific words
 when there's a clearer English equivalent. "Data layer" instead
 of "feature service." "Map" instead of "web map." "Contributor"
 instead of "publisher." See **Terminology map** for the full
 list.
- **Hosting.** GratisGIS is self-hosted. You own the hardware,
 the data, and the license terms. No commercial license fees,
 no per-credit metering for things like geocoding or routing
 (you bring your own geocoder or use Nominatim).
- **The shape of the data model.** Items, sharing, and dependencies
 work the same way. Underneath, GratisGIS stores everything as a
 bitemporal observation log; you'll see hints of that in the
 **As of** time slider and the per-feature history view, but the
 day-to-day editor experience is the standard "edit a feature,
 hit save" loop.

## What's here

The pages in this section walk through the most common
"how do I do the AGO thing" questions:

- **Terminology map**. Which AGO term maps to which GratisGIS
 term. Print this and keep it next to your monitor for week one.
- **Feature service to data layer**. Moving a layer's content
 (or just its schema and symbology) over.
- **Web map to map**. Importing an AGO web map JSON.
- **Survey123 to form**. Importing an XLSForm.
- **App Builder comparison**. Where Experience Builder, Web
 AppBuilder, and Dashboard Designer concepts land here.

## What's NOT here

- **Wholesale "migrate my org" tooling.** There's no one-button
 import that brings every item from an AGO org into GratisGIS.
 The format mismatches and sharing-model differences make a
 fully automated path more dangerous than helpful. The pages
 here cover the per-item moves; do them deliberately.
- **Hybrid mode.** GratisGIS can reference an external AGO
 service as an **ArcGIS service** item (the data stays on AGO,
 you proxy through). That's a real ongoing pattern, not a
 migration step. See **ArcGIS service** under Items.
