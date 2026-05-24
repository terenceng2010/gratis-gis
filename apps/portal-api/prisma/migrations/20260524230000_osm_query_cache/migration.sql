-- Cache layer for OpenStreetMap Overpass queries (#OSM).
-- Each row is one hashed (presetIds, tagFilters, bbox, endpoint)
-- tuple.  The features themselves live in the shared
-- observation-log table under the `scope` written here, so the
-- recipe runner can read them via the same SQL path it uses for
-- data_layer sources.  Rows expire by TTL; a nightly job scrubs
-- the cache row plus its observation-log tail.

CREATE TABLE IF NOT EXISTS "osm_query_cache" (
  "hash"          TEXT          NOT NULL,
  "scope"         TEXT          NOT NULL,
  "preset_ids"    TEXT[]        NOT NULL,
  "tag_filters"   JSONB,
  "bbox"          JSONB         NOT NULL,
  "feature_count" INTEGER       NOT NULL,
  "endpoint"      TEXT          NOT NULL,
  "fetched_at"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"    TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "osm_query_cache_pkey" PRIMARY KEY ("hash")
);

-- Cleanup index: the scrub job runs `WHERE expires_at < now()`.
CREATE INDEX IF NOT EXISTS "osm_query_cache_expires_at_idx"
  ON "osm_query_cache" ("expires_at");

-- Diagnostic index: "which queries touched this preset recently"
-- is a useful operator question, hence the GIN on the preset
-- array column.
CREATE INDEX IF NOT EXISTS "osm_query_cache_presets_idx"
  ON "osm_query_cache" USING GIN ("preset_ids");
