# @gratis-gis/form-schema

JSON-serializable form definitions used by the form designer (web), the form
renderer (web + mobile), and the submission storage engine.

**Status:** placeholder. The final schema will be ported from the Survey123
Designer work Matt has referenced. The shape below is a minimal starting point
so the rest of the platform has something to type against; expect it to grow.

## Why a schema package?

- A form defined once must render identically on the web and in the field app.
- The server uses the schema to validate submissions and to create the
  underlying PostGIS submission table columns.
- Reports and dashboards inspect the schema to label fields.

Keeping the schema types in a single package avoids drift across consumers.

## Migration path from Survey123 Designer

When we port the designer UI, we'll:

1. Inventory the widget types it supports.
2. Add each widget's config as a discriminated-union arm in `Field`.
3. Write a one-way converter if any legacy form definitions need to move.
