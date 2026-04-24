-- Add the `geo-boundary` variant to ItemType. A geo_boundary item
-- is a named, authoritative polygon or multipolygon that can be
-- referenced from share geo-limits, web-map default extents, filter
-- UIs, and other 'point at a region' features. Mirrors the
-- pick_list pattern: define once, reference from many places.
-- Enum alters run standalone per Postgres rules.
ALTER TYPE "ItemType" ADD VALUE 'geo-boundary';
