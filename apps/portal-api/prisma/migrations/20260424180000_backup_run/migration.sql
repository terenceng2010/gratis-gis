-- Operator-visible history of backup runs (see #59). Infrastructure-
-- level: one table for the whole deployment, not per-org. Rows are
-- created the moment a run starts so a hung run still shows in the
-- admin page instead of looking like it never happened.
CREATE TYPE "BackupStatus" AS ENUM ('running', 'succeeded', 'failed');

CREATE TABLE "backup_run" (
  "id"          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  "started_at"  TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  "status"      "BackupStatus"  NOT NULL DEFAULT 'running',
  -- Filename only, not the full path. Resolves against BACKUP_DIR at
  -- read time so a deployment can be moved without a migration.
  "filename"    TEXT,
  "size_bytes"  BIGINT,
  "trigger"     TEXT            NOT NULL DEFAULT 'manual',
  "started_by"  UUID,
  "error"       TEXT
);

-- Admin UI sorts newest-first; retention sweeps also walk in order.
CREATE INDEX "backup_run_started_at_idx"
  ON "backup_run" ("started_at" DESC);
