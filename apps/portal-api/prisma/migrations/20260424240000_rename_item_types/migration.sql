-- Esri term-audit Phase B: rename ItemType values.
--   web-map       -> map         (drop the redundant "web-" prefix;
--                                 in the portal everything is already
--                                 web-facing, so the qualifier is dead
--                                 weight — same "in Italy it's just
--                                 food" reasoning)
--   feature-service -> data-layer  (feature_service is literally an
--                                 Esri product name and carries
--                                 trademark risk; "data layer" is the
--                                 generic GIS vocabulary for what
--                                 this actually is — a layer of
--                                 records with geometry + attributes)
--
-- Postgres doesn't support renaming enum values in place, so we swap
-- the whole type: rename old out, create new, recast the column with
-- a CASE expression that maps old values to new. All runs in a single
-- transaction so the table is never in an invalid state. Pre-launch
-- deployment; existing data is test-only and re-labelling is the
-- cheapest route.

ALTER TYPE "ItemType" RENAME TO "ItemType_old";

CREATE TYPE "ItemType" AS ENUM (
  'map',
  'data-layer',
  'arcgis-service',
  'form',
  'form-submission-collection',
  'web-app',
  'report-template',
  'dashboard',
  'file',
  'layer-package',
  'notebook',
  'tool',
  'widget-package',
  'pick-list',
  'geo-boundary'
);

ALTER TABLE "item"
  ALTER COLUMN "type" TYPE "ItemType"
  USING (
    CASE "type"::text
      WHEN 'web-map'         THEN 'map'::"ItemType"
      WHEN 'feature-service' THEN 'data-layer'::"ItemType"
      ELSE "type"::text::"ItemType"
    END
  );

DROP TYPE "ItemType_old";
