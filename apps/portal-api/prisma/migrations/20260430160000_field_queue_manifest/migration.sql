-- Tier 4 of the field-offline resilience design (see
-- docs/field-offline-areas.md). The field client periodically POSTs
-- a manifest of what's queued in its local IndexedDB so admins can
-- see "user X has 47 records queued, oldest from 3 days ago" without
-- the user pulling out their phone. Pure beacon: the actual record
-- payloads stay client-side; this table only carries metadata.
CREATE TABLE "field_queue_manifest" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_fingerprint" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "storage_usage" BIGINT,
    "storage_quota" BIGINT,
    "user_agent" TEXT,
    "reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "field_queue_manifest_pkey" PRIMARY KEY ("id")
);

-- One row per (user, device). Subsequent POSTs from the same device
-- upsert this row rather than appending; the admin view is interested
-- in current state, not history.
CREATE UNIQUE INDEX "field_queue_manifest_user_device_unique"
    ON "field_queue_manifest" ("user_id", "device_fingerprint");

-- Admin "show me devices that haven't reported in N days" sweep.
CREATE INDEX "field_queue_manifest_reported_at_idx"
    ON "field_queue_manifest" ("reported_at");

ALTER TABLE "field_queue_manifest"
    ADD CONSTRAINT "field_queue_manifest_user_id_fkey"
    FOREIGN KEY ("user_id")
    REFERENCES "user"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
