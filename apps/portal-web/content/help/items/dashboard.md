---
id: items-dashboard
title: Dashboard
summary: A grid of indicators, charts, and small maps that summarize a set of layers in one screen.
category: items
order: 60
complexity: intermediate
tags:
  - dashboard
  - item-type
  - reporting
related:
  - items-map
  - items-data-layer
  - items-report-template
---

A **dashboard** is a screen-sized grid of widgets, each bound to a
layer or computed metric, designed to be glanced at on a wall TV
or a phone. Use for operational status (open work orders, active
incidents, hydrant inspections this week) rather than detailed
analysis.

## What's in a dashboard

- **A grid layout**. Rows and columns of widget slots.
- **Widgets** in each slot:
  - **Number indicator**. A single big number with a label,
    optionally with a target / trend arrow.
  - **List**. The top N rows of a layer, sorted.
  - **Pie / bar chart**. Distribution of values across categories.
  - **Time series**. A computed metric over time.
  - **Small map**. A map item rendered at a fixed viewport.
  - **Filter chip**. Cross-widget filter; selecting a category in
    one widget filters every widget bound to the same layer.
- **A refresh interval**. How often the widgets re-query. Default
  is on page load; set to N seconds for live-board scenarios.

## Source data

Every dashboard widget sources from one of:

- A **data layer** sublayer.
- A **derived layer** result.
- An **ArcGIS REST** external service.

A dashboard can't ingest features directly. If you want to chart a
computed metric (rolling average, weekly delta), build it as a
derived layer first, then point a widget at it.

## Sharing

Standard three-tier. Public dashboards work well as a "stat board"
URL you embed in a Confluence page or a public website. Like web
apps, sharing the dashboard doesn't auto-share its dependencies.

## Editing

The dashboard editor is the detail page in `?view=configure` mode.
Same grid you'll see on the live dashboard, but each cell shows
the widget picker. Drag a widget in, configure its layer + field
binding, save.

## Cross-widget filtering

Filter chips wire together by **shared layer + field**. Drop a
chip widget bound to `incidents.priority`. Drop a chart widget
bound to `incidents.status`. Clicking "High" on the chip filters
the chart to high-priority incidents. The filter is client-side
and ephemeral; refresh the page and you're back to unfiltered.

## See also

- **Report template**. When you want a printable PDF instead of an
  interactive grid.
