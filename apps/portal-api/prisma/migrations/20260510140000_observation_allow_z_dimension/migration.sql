-- Allow any geometry dimension on observation.geom (#113).
--
-- The original typmod `geometry(Geometry, 4326)` pins the column to
-- 2D regardless of the type-code. Inserting a 3D source (GDB
-- elevation polygons, KML altitude points, photogrammetry-derived
-- vectors, anything carrying real Z) errors with `Geometry has Z
-- dimension but column does not` and the ingest pipeline dies.
--
-- Per the design call captured in #113, we want native Z preserved
-- end-to-end rather than silently flattened on the way in. PostGIS
-- spatial predicates (ST_Intersects, ST_Within, bbox) work fine on
-- mixed-dimension columns, MapLibre's GeoJSON consumer ignores the
-- third coordinate at render time, and the CSV / WKT export path
-- can opt to preserve or strip Z per-column going forward.
--
-- Drop the typmod entirely (any subtype, any dimension) and replace
-- the SRID enforcement with an explicit CHECK so a stray EPSG:3857
-- insert still gets rejected. Partitioned table: ALTER on the parent
-- propagates the column-level change to every existing partition.
-- The accompanying CHECK is added on the parent and inherited.

-- Step 1: relax the column typmod. Same physical layout (PostGIS
-- geometry blobs are dimension-agnostic), so this is a metadata-only
-- change that does not rewrite the heap.
ALTER TABLE observation
  ALTER COLUMN geom TYPE geometry
  USING geom::geometry;

-- Step 2: re-establish SRID 4326 enforcement at the table level.
-- The typmod previously gave us this for free; with the typmod
-- relaxed we replace it with a CHECK so any non-4326 insert still
-- fails fast at the DB rather than silently mixing CRS into a
-- supposedly-WGS84 dataset.
ALTER TABLE observation
  ADD CONSTRAINT observation_geom_srid_4326_check
    CHECK (geom IS NULL OR ST_SRID(geom) = 4326);
