-- Async AgoImportJob: decouples the AGO migration runner from the
-- wizard POST that kicks it off (#55). Wizard creates a queued
-- row, returns the id immediately, polls /run/:id for progress.
-- See model docstring on AgoImportJob for the full design.

-- Enum for AgoImportJob.status. Distinct from ImportJobStatus
-- (ingest pipeline) so the two job types can evolve separately.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AgoImportJobStatus') THEN
    CREATE TYPE "AgoImportJobStatus" AS ENUM (
      'queued',
      'running',
      'succeeded',
      'failed',
      'cancelled'
    );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "ago_import_job" (
  "id"              UUID                NOT NULL DEFAULT gen_random_uuid(),
  "created_by"      UUID                NOT NULL,
  "org_id"          UUID                NOT NULL,
  "status"          "AgoImportJobStatus" NOT NULL DEFAULT 'queued',
  "portal_url"      TEXT                NOT NULL,
  "total"           INTEGER             NOT NULL DEFAULT 0,
  "done"            INTEGER             NOT NULL DEFAULT 0,
  "current_item"    TEXT,
  "request_payload" JSONB               NOT NULL,
  "report"          JSONB,
  "error_message"   TEXT,
  "created_at"      TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at"      TIMESTAMP(3),
  "finished_at"     TIMESTAMP(3),
  CONSTRAINT "ago_import_job_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ago_import_job_user_created_idx"
  ON "ago_import_job" ("created_by", "created_at");

CREATE INDEX IF NOT EXISTS "ago_import_job_org_status_idx"
  ON "ago_import_job" ("org_id", "status");
