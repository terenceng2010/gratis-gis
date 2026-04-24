-- Point-in-time copy of an Item's data blob, written on every
-- data-replace event (upload, paste, bulk import). Lets admins
-- undo a bad replace for up to 30 days or the latest 20 snapshots
-- per item, whichever is stricter. A cron in MaintenanceModule
-- enforces the retention.
CREATE TABLE "item_data_snapshot" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "item_id"    UUID NOT NULL REFERENCES "item"("id") ON DELETE CASCADE,
  "data"       JSONB NOT NULL,
  "note"       TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" UUID NOT NULL
);

-- Composite index supports the two hot queries:
--   1. list snapshots for an item, newest first
--   2. purge pass scans (itemId, createdAt) to enforce TTL + cap
CREATE INDEX "item_data_snapshot_item_id_created_at_idx"
  ON "item_data_snapshot" ("item_id", "created_at" DESC);
