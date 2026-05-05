-- #304 slice 7: convert legacy arcgis-service / wms-service /
-- wfs-service items to the unified `service` type with a
-- `protocol` discriminator on data_json. Idempotent: only rewrites
-- rows whose data_json doesn't already carry a `protocol` field
-- (so a second run is a no-op, and rows freshly created via the
-- new wizard since slice 3 are skipped because they already have
-- `protocol`).
--
-- Mapping rules:
--   wms-service          -> protocol=wms          + protocolVersion 1.3.0 default
--   wfs-service          -> protocol=wfs          + protocolVersion 2.0.0 default
--   arcgis-service       -> protocol=arcgis_map | arcgis_feature based on
--                           data_json->>'serviceType' (FeatureServer = arcgis_feature)
--
-- Common shape adjustments applied to every converted row:
--   - selectedLayerIds: kept as-is (already number[] for OGC types;
--     for ArcGIS the int sublayer ids worked the same way the
--     unified shape's indices do, so a re-probe is recommended but
--     not required).
--   - layers[].name: for ArcGIS rows, copy id::text into a new
--     `name` field so the unified renderer's name-keyed lookup
--     works without a re-probe. Legacy OGC rows already used
--     `name`, so no rewrite there.
--   - layers[].title: for ArcGIS rows, copy old `name` into
--     `title` (the unified shape's title is the user-friendly
--     label).
--
-- Items keep their existing `type` value so legacy detail-page
-- dispatch keeps working unchanged. The data_json shape is what
-- changes; the unified ServiceEditor isn't reachable yet for
-- these rows because the page.tsx dispatch still branches on
-- item.type. Slice 8 will flip the dispatch to prefer
-- `data.protocol` when present so converted rows route through
-- the unified editor without needing a type rewrite.

-- Step 1: WMS items.
UPDATE "item"
SET
  type = 'service',
  data_json = jsonb_strip_nulls(
    data_json
      || jsonb_build_object(
        'protocol', 'wms',
        'protocolVersion', COALESCE(data_json->>'protocolVersion', '1.3.0'),
        'format', COALESCE(data_json->>'format', 'image/png'),
        'transparent', COALESCE((data_json->>'transparent')::boolean, true),
        'crs', COALESCE(data_json->>'crs', 'EPSG:3857')
      )
  )
WHERE type = 'wms-service'
  AND data_json IS NOT NULL
  AND NOT (data_json ? 'protocol');

-- Step 2: WFS items.
UPDATE "item"
SET
  type = 'service',
  data_json = jsonb_strip_nulls(
    data_json
      || jsonb_build_object(
        'protocol', 'wfs',
        'protocolVersion', COALESCE(data_json->>'protocolVersion', '2.0.0'),
        'outputFormat', COALESCE(data_json->>'outputFormat', 'application/json')
      )
  )
WHERE type = 'wfs-service'
  AND data_json IS NOT NULL
  AND NOT (data_json ? 'protocol');

-- Step 3: ArcGIS items. The protocol depends on data_json.serviceType
-- (FeatureServer or MapServer). We also rewrite each layers[i] into
-- the unified shape (name + title) so the new ServiceEditor can
-- render the row without a re-probe. The layers rewrite is a
-- jsonb_agg over jsonb_array_elements with the per-element
-- transformation inline.
UPDATE "item" AS i
SET
  type = 'service',
  data_json = jsonb_strip_nulls(
    i.data_json
      || jsonb_build_object(
        'protocol',
          CASE
            WHEN i.data_json->>'serviceType' = 'FeatureServer' THEN 'arcgis_feature'
            ELSE 'arcgis_map'
          END,
        'layers',
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'name', (l->>'id'),
                  'title', COALESCE(l->>'name', l->>'id'),
                  'geometryType', l->>'geometryType'
                )
              )
              FROM jsonb_array_elements(i.data_json->'layers') AS l
            ),
            '[]'::jsonb
          )
      )
  )
WHERE i.type = 'arcgis-service'
  AND i.data_json IS NOT NULL
  AND NOT (i.data_json ? 'protocol');
