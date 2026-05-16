---
id: print-templates-parameters
title: Parameters
summary: The inputs a runner supplies when generating a report. Types, defaults, validation.
category: print-templates
order: 20
complexity: intermediate
tags:
  - print-templates
  - parameters
related:
  - print-templates-overview
  - print-templates-tokens
---

A report template's **parameters** are the inputs the runner
supplies at generation time. The detail page renders a form from
the parameter list; submitting the form runs the template with
those values.

## Supported parameter types

- **Text**. A short string.
- **Long text**. A multi-line string. Use for free-form notes.
- **Number**. Integer or decimal.
- **Date** / **Datetime**. Calendar picker.
- **Boolean**. A checkbox.
- **Feature reference**. A picker that lets the runner choose a
 single feature from a bound layer. Common for "report on this
 parcel."
- **Feature ID list**. A multi-pick variant.
- **Date range**. A pair of dates. Common for "report covering
 January 1 to January 31."
- **Layer reference**. A picker for a layer item. Lets the same
 template work against any of several layers.
- **Choice**. Single-pick from a fixed list. The list is
 authored on the parameter.
- **Pick list reference**. Single-pick where the list comes from
 a Pick list item.

Each parameter has a name, a type, an optional default, and an
optional validation rule (min, max, required, regex).

## Authoring

In the report template detail page, the **Parameters** tab is
the editor. Each parameter is a row:

- **Name** (machine name). Used as the placeholder reference in
 the body (`{{ params.<name> }}`).
- **Label**. What the runner sees in the form.
- **Type**.
- **Default value**.
- **Required** toggle.
- **Help text** (shown under the field).

## Computed defaults

Some parameter types support a computed default:

- **Date**: `today()`.
- **Datetime**: `now()`.
- **Feature reference**: when run from a feature's context menu
 (right-click → Generate report), the clicked feature is the
 default.
- **User**: the running user is the default (built-in user
 parameter).

## Running

The detail page's **Run** section renders the parameter form. The
runner fills it in; the portal validates against the parameter
constraints; on submit, the template runs and downloads the
output.

When run from a feature context menu, the matching parameter
defaults to that feature and the form pre-fills. Common pattern:
one click on a parcel → one click on "Generate report" →
the PDF downloads.

## Notes

- **Required parameters** can't be left blank. The form blocks
 submission until they're filled.
- **Validation runs server-side too.** A user fiddling with the
 URL can't bypass the form constraints.
- **The parameter form is the user's primary surface.** Make
 names and labels match the parameter's purpose; helper text
 prevents wrong inputs more than after-the-fact validation does.
