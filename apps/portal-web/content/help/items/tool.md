---
id: items-tool
title: Tool
summary: A reusable analysis operation packaged as an item, runnable on demand against caller-supplied inputs.
category: items
order: 170
complexity: advanced
tags:
  - tool
  - item-type
  - analysis
related:
  - items-derived-layer
  - items-notebook
---

A **tool** is an item that wraps a single named analysis operation
with a documented signature: declared inputs, declared parameters,
declared outputs. Run it from its detail page, from a web app, or
from another tool's pipeline.

Tools are the right item type when the same operation is run many
times against different inputs and you want it to live in the
catalog as a citable, shareable thing.

## Tool vs. derived layer

- **Derived layer**. Produces a specific output layer from
 specific inputs. The layer IS the result.
- **Tool**. A reusable operation. Runs against caller-supplied
 inputs. Each run produces a new output (or modifies an existing
 one).

If you find yourself cloning the same derived layer with
different inputs, the operation should probably be a tool.

## What's stored

- **A name and description**.
- **Input slots**, each with a declared type (data layer, derived
 layer, geo boundary, single feature, etc.) and whether required.
- **Parameter slots**, each with a type (number, string, choice
 list, distance, etc.) and a default.
- **Output declaration**. What the tool produces (a new derived
 layer, a row count, a file, a side effect on an existing item).
- **The implementation**. Either a built-in operation reference
 (one of the analysis steps) OR a script wrapped in the tool
 runtime.

## Built-in tools vs. custom tools

The portal ships with built-in tools for the common cases (each
analysis step is exposed as a tool). Custom tools let you bundle
a multi-step pipeline with named parameters into one runnable
unit.

A custom tool's implementation today is a derived-layer pipeline
template: the same step types, just parameterized by tool inputs.
A scripting hook (Python or JS) is planned but not in v1.

## Running a tool

The detail page has a **Run** form. Fill in the inputs and
parameters, click **Run**. The output appears (new item created,
or existing item updated). Runs are logged to the tool's history
tab.

## Sharing

Standard three-tier. A public tool is runnable by anyone with the
link; an org-only tool is gated.

## Notes

- **Tools are not webhooks.** They run synchronously in a request.
 If you need scheduled or event-driven runs, schedule them via
 the admin scheduler.
- **Quotas.** Org admins can set a per-tool runtime limit and a
 per-user concurrent-run cap.
