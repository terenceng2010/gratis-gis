---
id: analysis-calculate
title: Calculate
summary: Add a computed column to a layer. The same input rows, plus one or more new derived attributes.
category: analysis
order: 20
complexity: basic
tags:
  - analysis
  - derived-layer
  - calculate
related:
  - items-derived-layer
  - analysis-filter
---

A **calculate** step adds a new field to the output rows whose
value is computed from existing fields (or computed from the
geometry itself: area, length, centroid coordinates).

## Inputs

- **Source layer**.
- **One or more new fields**, each with:
  - A **name** (column header).
  - A **type** (text, integer, decimal, date, boolean).
  - An **expression** that produces the value.

## Expression vocabulary

The expression dialect is a small functional language:

- **Field references**: bare identifiers (`status`, `acres`).
- **Arithmetic**: `+`, `-`, `*`, `/`, `%`. Integer/decimal handled
 like SQL.
- **String concatenation**: `||`. (`first || ' ' || last`).
- **Comparison + Boolean**: `=`, `!=`, `<`, `>`, `and`, `or`,
 `not`.
- **Conditional**: `case when ... then ... else ... end`.
- **Functions**: `upper(x)`, `lower(x)`, `length(x)`, `round(x, n)`,
 `coalesce(x, y)`, `cast(x as decimal)`, `now()`, `today()`.
- **Geometry helpers**: `area_m2()`, `area_ft2()`, `length_m()`,
 `length_ft()`, `centroid_x()`, `centroid_y()`, `bbox_west()`,
 ...

## Output

The source rows, unchanged, plus the new fields. The geometry is
unchanged.

## Examples

- **Acreage from polygon area**:
 `acres = area_m2() / 4046.8564`.
- **Full name** from first and last:
 `full_name = first || ' ' || last`.
- **Status flag**:
 `is_overdue = case when due < today() and status != 'closed' then true else false end`.
- **Buffer-ready label**:
 `display = upper(coalesce(name, 'UNKNOWN'))`.

## When NOT to use Calculate

- **One-off value transforms in a popup**. Don't add a derived
 column just so a popup can show formatted output. The popup
 template can interpolate fields directly.
- **Per-user values**. Calculate is per-row; it doesn't know who
 the viewer is. Per-user logic happens at query time.

## Notes

- **Expressions are evaluated at materialization time.** Refresh
 the derived layer when the source changes.
- **Type coercion** follows SQL rules; `cast(x as integer)` is
 the explicit form when you don't want to rely on coercion.
- **NULL propagates** through arithmetic: `1 + null = null`.
 Use `coalesce` to default a NULL before computing.
