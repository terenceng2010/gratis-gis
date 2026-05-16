---
id: items-notebook
title: Notebook
summary: A reference to a Jupyter-style analysis notebook. The portal stores the file and metadata; execution runs outside.
category: items
order: 160
complexity: advanced
tags:
  - notebook
  - item-type
  - analysis
related:
  - items-data-layer
  - items-derived-layer
---

A **notebook** is an item that wraps a Jupyter-style analysis
notebook (`.ipynb`) along with the metadata needed to discover and
share it. The portal does not execute notebooks; this item type
is a catalog entry, not a kernel host.

## Why this exists

Analysts often write one-off scripts that produce maps or
derived metrics. Those scripts go stale, lose context, or live
in someone's laptop and disappear when they leave. The notebook
item gives an analytic asset the same lifecycle as any other
portal item: a stable id, an owner, sharing, tags, dependency
tracking, and search.

## What's stored

- **The notebook file** (`.ipynb`), in MinIO.
- **Title, description, tags, sharing**: standard for all items.
- **Declared inputs**. A list of layer items the notebook reads
 from. Filling this out makes the notebook discoverable from the
 layer's detail page ("notebooks that use this").
- **Declared outputs**. Files, layer-update operations, or
 derived layers the notebook produces. Also discoverable from
 those items.

The inputs and outputs are author-declared. The portal doesn't
parse the notebook to extract them.

## Running a notebook

Out of scope for this item type. The expected pattern:

1. Download the notebook from the detail page.
2. Run it locally (or on your own JupyterHub) against the portal's
 API.
3. Re-upload an updated notebook if the result is something
 you'll re-run.

A future surface ("Notebook runs") might add scheduled execution
against a managed kernel; not in scope today.

## See also

- **Derived layer**. The right item type when the analysis is
 stable enough to express as a pipeline of named steps.
