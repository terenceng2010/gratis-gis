-- #103: per-org Overpass endpoint override. Null falls back to env / default.
ALTER TABLE "organization"
  ADD COLUMN "osm_overpass_endpoint" TEXT;
