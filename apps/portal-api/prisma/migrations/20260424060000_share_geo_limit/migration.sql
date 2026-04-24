-- Adds an optional GeoJSON polygon column to item_share for per-share
-- geographic access restriction ("geo limits" in GeoNode parlance).
-- Null means no restriction — the share grants full access to the item
-- per its permission level. When set, the query path clips features to
-- rows whose geom intersects the polygon and filters items whose bbox
-- doesn't intersect it.
ALTER TABLE "item_share"
  ADD COLUMN "geo_limit" jsonb;
