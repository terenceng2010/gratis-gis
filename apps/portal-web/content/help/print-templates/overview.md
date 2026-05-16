---
id: print-templates-overview
title: Print template overview
summary: How report templates produce paper-shaped documents from layer data, and when to pick a template over the Print widget.
category: print-templates
order: 10
complexity: basic
tags:
  - print-templates
  - reporting
related:
  - items-report-template
  - widget-print
  - print-templates-parameters
  - print-templates-tokens
---

A **print template** (technically a report template item; see
**Report template** under Items) produces a paper-shaped document
populated from layer data when someone runs it. The output is a
PDF (default) or DOCX, downloaded directly or archived on the
item.

This page is the conceptual orientation. The Items section's
**Report template** page is the item-type reference; this section
is the workflow / authoring view.

## Print template vs. Print widget

Both produce printable output. They answer different questions.

- **Print widget** prints "this map view." Whatever's on screen,
 plus a legend / scale / north arrow, becomes a paper map. One
 click, no template authoring.
- **Print template** prints "this thing, with that data filled
 in." A pre-authored document with placeholders that resolve
 against parameters the user supplies at run time.

Pick the widget when the audience wants a paper map. Pick the
template when the audience wants a structured document
(inspection report, regulatory submission, monthly summary)
populated from specific features.

## The lifecycle

1. **Author the document**. Either in the in-portal rich-text
 editor or by uploading a DOCX with placeholder tokens.
2. **Define parameters**. What the runner provides: a feature id,
 a date range, a filter expression, a free text string. Each
 has a name, a type, an optional default.
3. **Bind placeholders**. Each placeholder in the body resolves
 to a value computed from parameters and the layer data.
4. **Test run**. Generate once with sample parameters; verify
 the output renders correctly.
5. **Share**. Set sharing tier; the template's detail page becomes
 the run surface.

## See also

- **Parameters**. The parameter form and the supported types.
- **Template tokens**. The placeholder syntax in the document
 body.
- **Report template** (under Items). The item-type reference.
