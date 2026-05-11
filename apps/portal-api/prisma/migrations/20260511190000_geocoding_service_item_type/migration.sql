-- #74 geocoding_service item type. Wraps a data_layer + search
-- fields config and exposes /api/portal/geocode/:itemId at runtime.
-- The data_json shape is GeocodingServiceData from shared-types.

ALTER TYPE "ItemType" ADD VALUE 'geocoding-service';
