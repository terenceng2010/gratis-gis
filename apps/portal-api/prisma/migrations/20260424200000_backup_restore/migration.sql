-- Audit trail of restore operations. Distinct from BackupRun
-- (which tracks backup creation) because restore is strictly
-- destructive and deserves its own history table so the success /
-- failure record can't be overwritten by the very operation it
-- documents. Written AFTER the restore completes on the new DB
-- state; the archive's own BackupRun rows document the creation
-- side.
CREATE TYPE "RestoreStatus" AS ENUM ('running', 'succeeded', 'failed');

CREATE TABLE "backup_restore" (
  "id"          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  "from_run_id" UUID,
  "filename"    TEXT            NOT NULL,
  "started_at"  TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  "status"      "RestoreStatus" NOT NULL DEFAULT 'running',
  "started_by"  UUID            NOT NULL,
  "error"       TEXT
);

CREATE INDEX "backup_restore_started_at_idx"
  ON "backup_restore" ("started_at" DESC);
