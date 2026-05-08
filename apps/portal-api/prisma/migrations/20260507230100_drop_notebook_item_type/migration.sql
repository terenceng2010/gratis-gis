-- Drop the `notebook` ItemType from the v1 platform. v1 is shipping
-- without a hosted-Jupyter feature; instead, the engine exposes a
-- read-only data API and users connect their own Jupyter / VS Code /
-- whatever via personal access tokens (see docs/byo-notebook.md). The
-- `tool` item type covers the "reusable computation" use case that
-- justified having notebooks as items in the first place.
--
-- Postgres has no in-place "ALTER TYPE DROP VALUE", so we swap the
-- whole enum: rename the old type out of the way, create a new one
-- without `notebook`, ALTER TABLE the column to the new type, drop
-- the old. Same pattern as 20260424240000_rename_item_types.
--
-- Pre-flight: 0 items have type='notebook' in dev or prod
-- (verified manually 2026-05-07). The USING clause below assumes
-- this; a stray notebook row would fail the cast and the migration
-- would abort, surfacing it to the operator.

ALTER TYPE "ItemType" RENAME TO "ItemType_old";

CREATE TYPE "ItemType" AS ENUM (
  'map',
  'data-layer',
  'derived-layer',
  'arcgis-service',
  'form',
  'form-submission-collection',
  'web-app',
  'report-template',
  'dashboard',
  'file',
  'layer-package',
  'tool',
  'widget-package',
  'pick-list',
  'geo-boundary',
  'basemap',
  'wms-service',
  'wfs-service',
  'folder',
  'editor',
  'data-collection',
  'service'
);

ALTER TABLE "item"
  ALTER COLUMN "type" TYPE "ItemType"
  USING ("type"::text::"ItemType");

DROP TYPE "ItemType_old";
