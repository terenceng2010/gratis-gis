-- Reverse the layer order convention for every existing map item.
--
-- The runtime layer-ordering convention used to be:
--   array[0] = first MapLibre layer added = BOTTOM of render stack
--              (the LayerList showed array[0] at the top, but the
--               map drew it behind everything else)
--   array[N-1] = last MapLibre layer added = TOP of render stack
--
-- This was inverse to the universal layered-graphics mental model
-- (QGIS, ArcGIS, Photoshop, Figma all use array[0] = top of render
-- = top of LayerList) and inverse to Esri's WebMap operationalLayers
-- spec ("lowest indexed layer rendered on top"), so importing
-- WebMap JSON silently rendered upside-down.
--
-- The companion change to syncOverlays in map-canvas.tsx flips the
-- iteration direction so array[0] becomes the LAST MapLibre layer
-- added (= top of map render). This migration reverses the
-- `data_json.layers` array on every existing `map` item so the
-- visual map appearance is preserved: whatever was drawn on top
-- yesterday is still on top tomorrow. The LayerList display order
-- reverses with it, which is what users actually want -- they were
-- already used to the AGO / QGIS convention.
--
-- One-way: re-running this migration on top of itself would flip
-- the order again and break maps. Prisma's migrate-history table
-- protects against that, and we never run migrations twice.

-- Note: Prisma's `model Item` maps to the lowercase `item` table via
-- @@map("item") in schema.prisma.  The first version of this
-- migration used "Item" and tripped 42P01 on prod.
UPDATE item
SET data_json = jsonb_set(
  data_json,
  '{layers}',
  (
    SELECT COALESCE(jsonb_agg(elem ORDER BY ord DESC), '[]'::jsonb)
    FROM jsonb_array_elements(data_json -> 'layers') WITH ORDINALITY AS t(elem, ord)
  )
)
WHERE type = 'map'
  AND data_json ? 'layers'
  AND jsonb_typeof(data_json -> 'layers') = 'array'
  AND jsonb_array_length(data_json -> 'layers') > 1;
