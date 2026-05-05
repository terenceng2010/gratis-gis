-- #304: add unified Connected Service item type. Replaces the four
-- protocol-specific types (arcgis-service, wms-service, wfs-service,
-- and the not-yet-shipped wmts) under a single shape with a `protocol`
-- discriminator on data_json. Legacy enum values stay so existing
-- rows keep dispatching to their detail pages until a one-shot
-- converter writes them as `service` rows.
ALTER TYPE "ItemType" ADD VALUE IF NOT EXISTS 'service';
