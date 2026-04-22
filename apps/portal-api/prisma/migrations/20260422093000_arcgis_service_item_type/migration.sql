-- Add the `arcgis-service` variant to ItemType. Postgres enums can't
-- be altered inside a transaction block, so we rely on Prisma's
-- migration runner to execute this statement standalone. Existing
-- rows are untouched; the new value is available for future inserts.
ALTER TYPE "ItemType" ADD VALUE 'arcgis-service';
