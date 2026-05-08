-- Swap the seeded `satellite` basemap from Esri's
-- server.arcgisonline.com/.../World_Imagery service to the USGS
-- National Map's USGSImageryOnly service.
--
-- Why: Esri's World_Imagery is freely accessible without an API key
-- but Esri's terms allow non-commercial use only; commercial /
-- production use technically requires an ArcGIS Online developer
-- key. A self-hosted open-source GIS portal pointing at it by
-- default puts every downstream tenant in a gray area. USGS
-- National Map imagery is U.S. Geological Survey work product
-- (public domain, no API key, explicit "free for any use"
-- terms; see https://www.usgs.gov/the-national-map-data-delivery
-- and the public-domain note on the parent endpoint).
--
-- Tradeoff: USGSImageryOnly covers the United States only. Orgs
-- serving other regions should replace the seeded basemap with a
-- region-appropriate imagery service of their own. Phase 2 of
-- the basemap promotion (#72/#74) made basemap a first-class
-- item type explicitly so this swap is one click in the admin
-- UI rather than a code change.
--
-- Only updates items whose tileUrl still points at the original
-- Esri URL. Custom-edited basemaps are left alone.

UPDATE "item"
SET "data_json" = jsonb_set(
  jsonb_set(
    jsonb_set(
      "data_json",
      '{tileUrl}',
      to_jsonb(
        'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'::text
      )
    ),
    '{attribution}',
    to_jsonb(
      'Imagery (c) U.S. Geological Survey, The National Map'::text
    )
  ),
  '{description}',
  to_jsonb(
    'USGS National Map aerial imagery. US coverage only; orgs serving other regions should add their own basemap item.'::text
  )
)
WHERE "type" = 'basemap'
  AND "data_json"->>'seededKey' = 'satellite'
  AND "data_json"->>'tileUrl' =
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
