---
id: print-templates-tokens
title: Template tokens
summary: The placeholder syntax authors put in the body to bind layer data into the rendered document.
category: print-templates
order: 30
complexity: advanced
tags:
  - print-templates
  - tokens
  - syntax
related:
  - print-templates-overview
  - print-templates-parameters
---

A **token** is a `{{ ... }}` placeholder in the report template's
body that resolves to a value at run time. Tokens can interpolate
single values, render tables, embed small maps, and conditionally
include sections.

## Single-value tokens

A bare reference resolves to a single value and emits inline:

```
{{ params.start_date }}
{{ feature.name }}
{{ feature.owner_name | upper }}
{{ feature.acres | round(2) }}
```

`params.<name>` references a parameter the runner supplied.
`feature.<field>` references a field on the feature parameter
(common when the template runs against one feature).

A pipe character (`|`) applies a filter:

- `upper` / `lower`: case conversion.
- `round(n)`: round numeric values to `n` decimal places.
- `date('Y-m-d')`: format a date with a strftime-style pattern.
- `coalesce(fallback)`: substitute `fallback` if the value is
 NULL.
- `default('N/A')`: same idea, shorter syntax.

Filters can chain: `{{ feature.due_date | date('Y-m-d') | upper }}`.

## Iteration

A `for` block emits its body once per row of a multi-row query:

```
{{ for row in query('inspections', filter='parcel_id = ' || feature.id) }}
  {{ row.inspected_at | date('Y-m-d') }}: {{ row.notes }}
{{ end }}
```

The body sees `row.<field>` for each iteration. The `query(...)`
helper runs a SQL-like query against the named layer; the result
rows are iterated. Other helpers (`relatedRows(...)`,
`siblings(...)`) cover common shapes without writing a raw
query.

## Conditional inclusion

```
{{ if feature.status = 'failed' }}
  This parcel failed inspection on {{ feature.last_inspected | date }}.
{{ end }}
```

Same Boolean expression dialect as filters and conditional
visibility.

## Embedded maps

```
{{ map(layer='hydrants', bbox=feature.bbox, w=400, h=300) }}
```

Renders a small map server-side and inlines it as an image (PNG)
in PDF, or as an embedded image in DOCX. Common parameters:

- `layer`: which layer (or layers, as a list) to render.
- `bbox`: extent. Can come from a feature, a geo boundary, or
 an explicit `[w, s, e, n]`.
- `w`, `h`: pixel dimensions.
- `basemap`: basemap reference; default is the template's
 chosen basemap.

## Notes

- **Token errors fail the run.** A typo like
 `{{ feature.nme }}` raises an error and the run aborts (no
 partial output). Use `coalesce` or `default` to handle
 expected NULLs.
- **Token output is escaped** in DOCX bodies (Word's XML
 escaping). HTML / PDF rendering respects whitespace in the
 token result.
- **Map rendering is the slow part.** A template with five
 embedded maps takes ~5x longer to generate than one with no
 maps. Keep map embeds to where they add value.
