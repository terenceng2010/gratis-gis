# Survey Response Viewer runtime

Every Form item has a built-in Response Viewer at
`/items/<formId>/responses`. The Form item detail page links to it
via "View responses"; opening it shows a layout that combines a map
(when the paired data_layer has geometry), an attribute table over
the submissions, and a Form View panel that renders the selected
row through the form's question structure.

This is implicit on every form — the user does not have to create
a separate "Survey" web_app item to get a response browser. Make a
form, collect submissions, click View responses. Done.

A separate `web_app` Survey template (#260) still exists for the
case where the user wants to configure something specific (a
particular reference map, custom toolbar trim, default lookback
window, hideSubmitter) and persist that configuration as its own
shareable item. But it's a power-user surface; the implicit
per-form viewer is the default path.

The reference is Esri's Survey123 Data tab. We don't copy 1:1, but
the structural decisions land in roughly the same place because the
two products are solving the same problem.

## Layout

```
+--------------------------------------------------------+
| Header: title | date-range | filter | report | export | layers | table | form |
+----------------------------+---------------------------+
| Map canvas (when geometry) | Form View (when toggled)  |
|                            |   - Submitted by / at     |
|                            |   - Question 1 + value    |
|                            |   - Question 2 + value    |
|                            |   - ...                   |
+----------------------------+                           |
| Attribute Table tabs (one per related layer)           |
| ( ATTENDEES | DAILY TAILGATE FORM )                    |
| Time | Conducted by | Project | Number | Client | ... |
| ----------------------------------------------------- |
| 06:00 | Sandra Nash | LADWP Path 46 | 14553.47 | LADWP |
+--------------------------------------------------------+
```

Adapts:

- **Spatial paired layer** -> map canvas takes the top half, attribute
  table the bottom half, form view slides in from the right over both.
- **Non-spatial paired layer** -> map area collapses to nothing, the
  attribute table fills the available height, form view still slides
  in from the right. (Detected on the server: `geometryType === null`
  on the paired sublayer.)

## Components

### Form View side panel

Renders the selected row formatted as the form, not as a row of
columns. Walks the FormSchema's questions list in order, looks up
each question's bound column on the row, and renders the value with
a question-type-aware widget:

- text / multiline -> plain text
- select-one (with coded-value domain) -> the label, not the code
- select-many -> comma-separated labels
- date / time / datetime -> formatted in the user's locale
- boolean -> "Yes" / "No"
- photo / video / audio -> link or thumbnail (#267 attachment list
  pattern)
- group / repeat -> nested block with child questions
- page -> section header
- note / divider / acknowledge -> static guidance, no value
- hidden -> skipped

Header carries the form title, who submitted, when. Footer / aside
icons hold the per-record actions: edit (only when the user can
edit submissions, currently never -- surveys are read-only by
design), delete (same), print (#132 once it lands).

Prev / next arrows step through the current selection set so the
user can walk responses without going back to the table.

### Date-range chip

The form's submissions table always carries `submitted_at`. When the
SurveyData carries `defaultLookbackDays`, the chip seeds to "now-N to
now". Users can edit the range or clear it. The filter applies
client-side via the layer's MapLayerFilter.

### Attribute filter

Reuses the existing data_layer FilterEditor. Surface as a "Filter"
button next to the date-range chip; clicking opens the editor in a
popover.

### Export menu

Split button. Submenu:

- "Selected records only" toggle (default off)
- CSV (server-side, existing /export endpoint)
- Excel (server-side, new endpoint that wraps the data into xlsx)
- Shapefile (server-side, GDAL conversion -- only when geometry)
- File Geodatabase (server-side, GDAL conversion -- only when
  geometry)

Phase 1 ships CSV + Excel. Shapefile / FGDB land when we wire GDAL
into the API container's existing libgdal-dev install.

### Report button

Hooks into a report_template item (#132) that defines the layout.
Phase 1 placeholder; activates when the user has a report_template
selected (or has a default template configured at the survey app
level).

### Tabs (per related layer)

A multi-layer paired data_layer (form with attachment groups, repeats,
or related-event-layer pattern) has more than one sublayer. The
attribute table grows tabs across the top, one per sublayer; the
active tab swaps the rows + the form-view's schema branch (groups
vs root layer).

Phase 1 ships a single-tab table for the form's primary layer; tabs
land once #292 (related-table attachments) is verified end-to-end
in a survey context.

## Implementation slices

1. **Form View panel + selection sync** (this slice). Build the panel
   as a side slide-in alongside the existing EditorRuntime layers /
   table panels. Drive it off `selection` + the bound form's
   FormSchema. Adds a "Form view" toggle in the header. Prev / next
   nav over the current selection.
2. **Non-spatial layout**. Detect `geometryType === null` on the
   paired sublayer and render a map-less layout (table fills the
   height, form view slide-in still works).
3. **Date-range chip + attribute filter**. Defaults to
   `defaultLookbackDays`-based window. Filter button opens
   FilterEditor.
4. **Export menu (CSV + Excel)**. Selected-records toggle, server-
   side endpoint that streams the result.
5. **Tabs across related layers**.
6. **Report button + report_template wiring** (after #132).
7. **Shapefile / FGDB exports** (after GDAL plumbing is in).

## Why not just reuse EditorRuntime as-is

EditorRuntime is the right substrate for "render a paired data_layer
on a map with an attribute table". The Survey runtime needs all of
that PLUS the form-view panel and a different layout for non-spatial
layers. We extend EditorRuntime with new optional props
(`formViewSchema`, `surveyMode`) rather than fork it, so the three
template runtimes (editor / viewer / survey) keep sharing one canvas
and one render path.
