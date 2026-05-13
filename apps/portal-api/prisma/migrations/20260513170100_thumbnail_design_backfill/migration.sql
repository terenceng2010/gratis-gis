-- #66 backfill: every pre-existing item gets the type-default
-- thumbnail design so its auto-thumbnail starts rendering on the
-- next request without a code path to populate it lazily.  Color
-- choices mirror defaultThumbnailDesign() in shared-types; keep the
-- two in sync if the palette is ever rebalanced.
--
-- Rows that already have a thumbnail_url (legacy uploaded images)
-- still get a design, because the design is the durable
-- representation that drives future re-bakes once the upload path
-- is retired.  The service-layer decorator gives the upload URL
-- precedence over the synthesized SVG URL, so existing uploads
-- still show their custom image; the design is just along for the
-- ride until the user opens the designer.

UPDATE "item"
SET thumbnail_design = jsonb_build_object(
    'version', 1,
    'background', CASE type::text
        WHEN 'map' THEN '#ecfdf5'
        WHEN 'data_layer' THEN '#f0f9ff'
        WHEN 'derived_layer' THEN '#eff6ff'
        WHEN 'arcgis_service' THEN '#ecfeff'
        WHEN 'form' THEN '#f5f3ff'
        WHEN 'form_submission_collection' THEN '#f5f3ff'
        WHEN 'web_app' THEN '#fffbeb'
        WHEN 'report_template' THEN '#fff1f2'
        WHEN 'dashboard' THEN '#eef2ff'
        WHEN 'file' THEN '#f8fafc'
        WHEN 'layer_package' THEN '#ecfdf5'
        WHEN 'tool' THEN '#f0fdfa'
        WHEN 'widget_package' THEN '#f0fdfa'
        WHEN 'pick_list' THEN '#f7fee7'
        WHEN 'geo_boundary' THEN '#fff7ed'
        WHEN 'basemap' THEN '#f1f5f9'
        WHEN 'wms_service' THEN '#ecfeff'
        WHEN 'wfs_service' THEN '#ecfeff'
        WHEN 'service' THEN '#ecfeff'
        WHEN 'folder' THEN '#fffbeb'
        WHEN 'editor' THEN '#faf5ff'
        WHEN 'data_collection' THEN '#f5f3ff'
        WHEN 'geocoding_service' THEN '#fff7ed'
        WHEN 'tile_layer' THEN '#fdf4ff'
        WHEN 'app_template' THEN '#fffbeb'
        WHEN 'theme' THEN '#fdf2f8'
        ELSE '#f8fafc'
    END,
    'sidebar', CASE type::text
        WHEN 'map' THEN '#10b981'
        WHEN 'data_layer' THEN '#0284c7'
        WHEN 'derived_layer' THEN '#1d4ed8'
        WHEN 'arcgis_service' THEN '#0891b2'
        WHEN 'form' THEN '#7c3aed'
        WHEN 'form_submission_collection' THEN '#8b5cf6'
        WHEN 'web_app' THEN '#d97706'
        WHEN 'report_template' THEN '#e11d48'
        WHEN 'dashboard' THEN '#4f46e5'
        WHEN 'file' THEN '#475569'
        WHEN 'layer_package' THEN '#047857'
        WHEN 'tool' THEN '#0d9488'
        WHEN 'widget_package' THEN '#0f766e'
        WHEN 'pick_list' THEN '#65a30d'
        WHEN 'geo_boundary' THEN '#ea580c'
        WHEN 'basemap' THEN '#334155'
        WHEN 'wms_service' THEN '#0e7490'
        WHEN 'wfs_service' THEN '#155e75'
        WHEN 'service' THEN '#0891b2'
        WHEN 'folder' THEN '#b45309'
        WHEN 'editor' THEN '#9333ea'
        WHEN 'data_collection' THEN '#6d28d9'
        WHEN 'geocoding_service' THEN '#c2410c'
        WHEN 'tile_layer' THEN '#c026d3'
        WHEN 'app_template' THEN '#b45309'
        WHEN 'theme' THEN '#db2777'
        ELSE '#475569'
    END,
    'sidebarLabelOverride', NULL,
    'backgroundImage', NULL
)
WHERE thumbnail_design IS NULL;
