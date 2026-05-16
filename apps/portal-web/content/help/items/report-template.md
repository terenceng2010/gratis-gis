---
id: items-report-template
title: Report template
summary: A parametrized document layout that produces a PDF (or DOCX) populated from layer data on demand.
category: items
order: 70
complexity: intermediate
tags:
  - report-template
  - item-type
  - reporting
  - pdf
related:
  - items-data-layer
  - items-dashboard
---

A **report template** is a document layout with placeholders that
the portal fills in from layer data when someone runs the report.
Use for inspection forms, regulatory submissions, monthly summary
reports, anything you'd hand to someone as a PDF.

## What's in a template

- **A document body**. Authored in the in-portal editor (rich
 text), or imported as a DOCX with placeholder tokens.
- **Parameters**. The inputs the user supplies at run time: a
 feature id, a date range, a filter expression. The detail page
 shows the parameter form.
- **Data bindings**. Each placeholder maps to a query against a
 layer using the parameters. The query result is interpolated
 inline (a single field), as a table (a multi-row result), or as
 a small map (rendered server-side from the result geometry).
- **Output format**. PDF (default) or DOCX. PDF is rendered
 server-side; DOCX is the source body re-emitted with placeholders
 filled.

## Token syntax

Inside the document body, placeholders look like:

```
{{ feature.field_name }}
{{ for row in inspections }}
  {{ row.inspected_at | date('Y-m-d') }}: {{ row.notes }}
{{ end }}
{{ map(layer='hydrants', bbox=feature.bbox, w=400, h=300) }}
```

The available filters (`date`, `upper`, `round`) are documented on
the **Template tokens** reference page.

## Running a report

Two ways to run:

- **From the report template detail page**. Fill in the parameter
 form, click **Generate**. The PDF/DOCX downloads.
- **From a feature's context menu**. Right-click a feature in the
 attribute table; if a report template is configured for that
 layer, **Generate report** appears with the feature pre-bound.

## Sharing

Standard three-tier. The template is the shared item; the
generated PDFs are not retained server-side by default. The
**Archive runs** toggle on the template enables run-history,
storing each generated PDF in MinIO with the parameters.

## See also

- **Dashboard**. When the audience wants an interactive screen, not
 a printable document.
