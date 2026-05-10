-- Async import jobs (#115).
--
-- Replaces the synchronous-streaming-NDJSON-from-the-wizard flow
-- with a fire-and-poll model: the wizard creates a row here and
-- navigates away immediately, a background worker drains the
-- queued rows, and the detail page reads progress from this table
-- to render an in-progress banner.
--
-- One row per per-layer ingest: a multi-layer GDB import enqueues
-- N rows that the worker processes in series (single-replica
-- portal-api today; future scale-out can swap in PG NOTIFY or a
-- real queue without touching this row's shape).

CREATE TYPE "ImportJobStatus" AS ENUM (
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled'
);

CREATE TABLE "import_job" (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id            UUID NOT NULL,
  layer_id           TEXT NOT NULL,
  staging_id         TEXT NOT NULL,
  source_file_name   TEXT NOT NULL,
  source_layer_name  TEXT NOT NULL,
  mode               TEXT NOT NULL,
  created_by         UUID NOT NULL,
  org_id             UUID NOT NULL,
  status             "ImportJobStatus" NOT NULL DEFAULT 'queued',
  total_features     INTEGER,
  processed_features INTEGER NOT NULL DEFAULT 0,
  inserted_features  INTEGER NOT NULL DEFAULT 0,
  error_message      TEXT,
  created_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at         TIMESTAMP(3),
  finished_at        TIMESTAMP(3),
  last_heartbeat_at  TIMESTAMP(3)
);

-- Hot path for the detail-page polling banner: "give me the
-- active import jobs for this item." Filters by org for visibility
-- isolation, item for the page context, status to skip terminal
-- rows. Composite index serves the common query exactly.
CREATE INDEX "import_job_org_item_status_idx"
  ON "import_job" (org_id, item_id, status);

-- Worker claim path: "next queued row, oldest first." Status
-- prefix gates the scan to a tiny set; created_at orders FIFO.
-- Index covers the worker's canonical query.
CREATE INDEX "import_job_status_created_idx"
  ON "import_job" (status, created_at);
