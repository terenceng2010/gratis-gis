---
id: analysis-workflows
title: Workflows (graphs of analysis steps)
summary: Express an analysis tool as a graph of connected steps so one step can feed into multiple downstream steps and multiple results can converge.
category: analysis
order: 5
complexity: intermediate
tags:
  - workflows
  - tools
  - recipe
  - dag
related:
  - items-tool
---

Tools in GratisGIS can run an analysis pipeline behind a single
button click. Phase 1 of tools shipped a linear pipeline — a
straight sequence of steps where each one feeds the next.
Workflows generalize that to a graph: one step can feed into
multiple downstream steps, and multiple upstream results can
converge into one.

This is the underlying engine improvement. The visual graph
editor that lets you drag nodes around a canvas is in the next
phase; today's recipe editor still presents the linear list,
and the workflow is structurally a chain. New node kinds for
true branching (joins, unions) land in the same Phase 2 commit
as the editor.

## What "graph" means here

If you're new to the term: imagine each analysis step as a box
on a whiteboard, and arrows between boxes showing where the
output of one box flows into the next box. The whole drawing is
a workflow graph.

The graph rule we enforce is that those arrows never form a
loop — you can't have an arrow that eventually comes back to a
box you already passed through. (In computer-science terms,
this is a "directed acyclic graph," or DAG.) The reason is
practical: a loop would let the engine run forever.

## What ships in Phase 1

The engine now reads a workflow as either:

- a **linear pipeline** (the existing shape every tool today
  uses), or
- a **graph** (a list of nodes plus a list of edges connecting
  them).

When a tool carries a graph, the engine sorts the nodes into
the right execution order, checks for loops, and runs them. If
a loop is detected, the tool refuses to run with a clear error
("This workflow has a cycle"); the author fixes the graph and
tries again.

Existing tools continue to work unchanged. Every tool you
authored before this lands keeps running as a linear pipeline.

## What's next

- **Phase 2** adds new node kinds that only make sense in a
  graph: a join node that takes two upstream layer results
  and matches them on a shared attribute, a union node that
  appends two upstream results together, geometry helpers like
  buffer / centroid / convex-hull as standalone nodes.
- **Phase 3** ships the visual graph editor — drag nodes onto
  a canvas, draw arrows between them, see the order at a
  glance. The current vertical-list editor stays as an
  alternate view for simple linear workflows.

## Why the change

Real analysis questions often aren't a straight line. "Give me
all parcels within 200 meters of a school, AND owned by the
city, AND not currently zoned residential" is three filters
that all need to apply. With a linear pipeline you can stack
them sequentially. But "parcels within 200m of a school" UNION
"parcels within 200m of a library" needs branching — the same
parcel layer feeds two parallel buffer steps that then
converge. Workflows make that natural.

## For tool authors

Nothing changes today. The recipe editor still presents the
familiar vertical-list view. When the visual graph editor
ships, it'll be a tab next to the existing editor so you can
pick whichever view fits the analysis you're building.

## Related

- [Tool item](items-tool) for the tool item type itself.
