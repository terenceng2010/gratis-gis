-- Add the four USGS National Map base map services as seeded
-- basemap items in every org. Source:
-- https://www.usgs.gov/faqs/what-are-base-map-services-or-urls-used-national-map
--
--   USGS Topo            Combined topo: boundaries, names,
--                        transportation, elevation, hydrography,
--                        land cover. Contours to 1:9,000.
--   USGS Shaded Relief   3DEP-driven raster relief, US coverage.
--   USGS Imagery Only    Aerial imagery, US; resolution ~6 in - 1 m.
--   USGS Imagery Topo    Imagery + contour / boundary / name overlay.
--
-- All four are public-domain USGS work product (no API key, free
-- for any use). US-only coverage; orgs serving other regions
-- should add their own region-appropriate basemap items.
--
-- Tile URL pattern note: ArcGIS MapServer tiles use {z}/{y}/{x}
-- (row-before-column / Esri convention). MapLibre handles this
-- placeholder swap natively.
--
-- The existing "Satellite" basemap (seededKey='satellite') was
-- migrated to USGSImageryOnly in 20260508073000; this migration
-- ALSO adds an explicitly-named "USGS Imagery Only" entry so the
-- four USGS basemaps appear together with consistent labeling
-- when a user is picking from the basemap menu. Slight tile-URL
-- duplication with Satellite is acceptable for the clearer UX.
--
-- Idempotency: WHERE NOT EXISTS on (org_id, seededKey) matches the
-- pattern in 20260424280000_seed_builtin_basemaps.

INSERT INTO "item" (
  "id", "org_id", "owner_id", "type", "title", "description", "tags",
  "data_json", "access", "created_at", "updated_at"
)
SELECT
  gen_random_uuid(),
  o."id",
  -- Owner: first admin in the org, else first user. Mirrors the
  -- original seed-builtin-basemaps migration.
  COALESCE(
    (SELECT u."id"
       FROM "user" u
       WHERE u."org_id" = o."id" AND u."org_role" = 'admin'
       ORDER BY u."created_at" ASC
       LIMIT 1),
    (SELECT u."id"
       FROM "user" u
       WHERE u."org_id" = o."id"
       ORDER BY u."created_at" ASC
       LIMIT 1)
  ),
  'basemap'::"ItemType",
  b."title",
  b."description",
  ARRAY['built-in', 'usgs']::text[],
  jsonb_build_object(
    'version',      1,
    'kind',         'tile-url',
    'tileUrl',      b."tile_url",
    'attribution',  b."attribution",
    'description',  b."description",
    'seededKey',    b."seeded_key"
  ),
  'org'::"ItemAccess",
  NOW(),
  NOW()
FROM "organization" o
CROSS JOIN (
  VALUES
    (
      'usgs-topo',
      'USGS Topo',
      'Combined topographic basemap (boundaries, names, transportation, elevation, hydrography, land cover). US coverage; contours visible to 1:9,000.',
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
      'Map services and data available from U.S. Geological Survey, National Geospatial Program.'
    ),
    (
      'usgs-shaded-relief',
      'USGS Shaded Relief',
      'Hillshade raster derived from the 3D Elevation Program (3DEP). US coverage including Alaska, Hawaii, and territories.',
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}',
      'Map services and data available from U.S. Geological Survey, National Geospatial Program.'
    ),
    (
      'usgs-imagery-only',
      'USGS Imagery Only',
      'Aerial imagery, US coverage; resolution ranges from 6 inches to 1 meter depending on region.',
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
      'Imagery (c) U.S. Geological Survey, The National Map.'
    ),
    (
      'usgs-imagery-topo',
      'USGS Imagery Topo',
      'Aerial imagery with US Topo overlay (contours, boundaries, names, hydrography, structures, transportation).',
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}',
      'Map services and imagery (c) U.S. Geological Survey, The National Map.'
    )
) AS b(seeded_key, title, description, tile_url, attribution)
WHERE NOT EXISTS (
  SELECT 1 FROM "item" i
  WHERE i."org_id" = o."id"
    AND i."type" = 'basemap'::"ItemType"
    AND i."data_json"->>'seededKey' = b."seeded_key"
)
AND EXISTS (
  SELECT 1 FROM "user" u WHERE u."org_id" = o."id"
);
