-- #230 Phase A: schema-change notification for live field deployments.
-- Adds the data_collection_schema_break NotificationType so the
-- items.service.ts data_layer save path can fan out a notification
-- to deployment owners when a layer they depend on is dropped or
-- has its geometryType swapped underneath them.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'data-collection-schema-break';
