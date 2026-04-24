-- Fix-up after the #70 item-type rename. The enum + TypeScript unions
-- were swapped (feature_service -> data_layer, web_map -> map), but
-- each map's `data` JSONB blob still carries the old strings nested
-- inside its layers array:
--   item.data.layers[i].source.kind === 'feature-service'
-- should become 'data-layer'. Consumers that walk layer sources (the
-- dependency extractor, the map canvas, the renderer) only know the
-- new value, so old maps appear to have broken references until the
-- stored data is rewritten.
--
-- Equivalent for 'web-map' layer sources even though the WebMapLayer
-- union never included it as a kind — defensive in case any
-- seed / test fixture ended up carrying it.
--
-- One UPDATE per kind, guarded by a jsonpath existence check so the
-- write is a no-op when a map has no layers needing rewrite.

-- feature-service -> data-layer
UPDATE "item"
SET "data_json" = (
  WITH updated AS (
    SELECT jsonb_agg(
      CASE
        WHEN layer->'source'->>'kind' = 'feature-service'
          THEN jsonb_set(layer, '{source,kind}', '"data-layer"'::jsonb)
        ELSE layer
      END
    ) AS new_layers
    FROM jsonb_array_elements("data_json"->'layers') AS layer
  )
  SELECT jsonb_set("data_json", '{layers}', COALESCE(new_layers, '[]'::jsonb))
  FROM updated
)
WHERE "type" = 'map'
  AND jsonb_path_exists(
    "data_json",
    '$.layers[*].source.kind ? (@ == "feature-service")'
  );

-- web-map -> map (belt-and-braces; no layer source union today emits
-- this but a tool-builder or older seed might have)
UPDATE "item"
SET "data_json" = (
  WITH updated AS (
    SELECT jsonb_agg(
      CASE
        WHEN layer->'source'->>'kind' = 'web-map'
          THEN jsonb_set(layer, '{source,kind}', '"map"'::jsonb)
        ELSE layer
      END
    ) AS new_layers
    FROM jsonb_array_elements("data_json"->'layers') AS layer
  )
  SELECT jsonb_set("data_json", '{layers}', COALESCE(new_layers, '[]'::jsonb))
  FROM updated
)
WHERE "type" = 'map'
  AND jsonb_path_exists(
    "data_json",
    '$.layers[*].source.kind ? (@ == "web-map")'
  );
