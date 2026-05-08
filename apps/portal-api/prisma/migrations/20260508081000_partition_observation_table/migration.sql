-- Phase 8 hardening: range-partition the engine's observation table
-- by `tx_time`, monthly, managed by pg_partman.
--
-- Why now: the engine concentrates every feature-level write into
-- one table. Phase 1 deliberately deferred partitioning to keep the
-- primary key on `id` alone (a partition column requirement would
-- have forced a composite PK). Now that the substrate is in
-- production and the surface is stable, we want partitioning in
-- place BEFORE volume forces our hand. Partition pruning, smaller
-- per-partition indexes, faster autovacuum, and the option to push
-- old partitions to cheaper storage all become possible once the
-- table is range-partitioned.
--
-- Cutover requires:
--   1. Postgres 16 (we already run it).
--   2. The pg_partman extension binaries available on the cluster
--      (the gratis-gis-postgres image now installs
--      `postgresql-16-partman` from the PGDG apt repo; see
--      infra/postgres/Dockerfile). Migrations that try to run
--      this against the unpatched postgis/postgis image fail at
--      `CREATE EXTENSION pg_partman` with an
--      "extension control file ... not found" error and the
--      whole migration aborts.
--   3. PRIMARY KEY moves from `id` alone to `(id, tx_time)` because
--      Postgres requires the partition column to be part of the PK
--      on a partitioned table. Application code already supplies
--      both columns on every write (uuidv7 id + tx_time default),
--      so no engine code changes.
--
-- Because Postgres can't ATTACH PARTITION onto an existing single-
-- column-PK table, the cutover is rename-old, create-new-
-- partitioned, copy-data, drop-old. Done in a single migration
-- file inside an implicit transaction so a mid-cutover failure
-- rolls cleanly back.

-- 1. Install pg_partman in its own schema (the upstream convention).
CREATE SCHEMA IF NOT EXISTS partman;
CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;

-- 2. Move the existing observation table out of the way. Also
--    rename its indexes so the new table can claim the original
--    names (Postgres ALTER TABLE RENAME does NOT cascade through
--    index renames automatically).
ALTER TABLE observation RENAME TO observation_pre_partition;
ALTER INDEX observation_pkey RENAME TO observation_pre_partition_pkey;
ALTER INDEX observation_geom_gix RENAME TO observation_pre_partition_geom_gix;
ALTER INDEX observation_scope_entity_validfrom_idx
  RENAME TO observation_pre_partition_scope_entity_validfrom_idx;
ALTER INDEX observation_cell_idx RENAME TO observation_pre_partition_cell_idx;
ALTER INDEX observation_attrs_gin RENAME TO observation_pre_partition_attrs_gin;
ALTER INDEX observation_tx_time_idx RENAME TO observation_pre_partition_tx_time_idx;

-- 3. Recreate observation as a range-partitioned table on tx_time.
--    Column shape matches the Phase 1 migration verbatim except for
--    the composite PK.
CREATE TABLE observation (
  id           UUID        NOT NULL,
  tx_time      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_from   TIMESTAMPTZ NOT NULL,
  valid_to     TIMESTAMPTZ,
  scope        TEXT        NOT NULL,
  entity       UUID        NOT NULL,
  kind         TEXT        NOT NULL CHECK (
                 kind IN ('create','update','delete','derive','observe')
               ),
  attrs        JSONB,
  geom         GEOMETRY(Geometry, 4326),
  cell         CHAR(15),
  author_sub   TEXT        NOT NULL,
  source       JSONB       NOT NULL,
  parents      UUID[]      NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, tx_time)
) PARTITION BY RANGE (tx_time);

-- 4. Re-declare every index on the parent. Postgres propagates
--    these to each existing and future partition automatically.
CREATE INDEX observation_geom_gix
  ON observation USING GIST (geom);
CREATE INDEX observation_scope_entity_validfrom_idx
  ON observation (scope, entity, valid_from DESC);
CREATE INDEX observation_cell_idx
  ON observation (cell);
CREATE INDEX observation_attrs_gin
  ON observation USING GIN (attrs jsonb_path_ops);
CREATE INDEX observation_tx_time_idx
  ON observation (tx_time DESC);

-- 5. Hand the parent table to pg_partman. Monthly partitions, with
--    24 future partitions pre-created. p_start_partition reaches
--    backwards to 2025-01-01 so any existing rows fit a real month
--    partition (the engine went into prod in mid-2026; 2025-01-01
--    is a safe floor).
SELECT partman.create_parent(
  p_parent_table    := 'public.observation',
  p_control         := 'tx_time',
  p_interval        := '1 month',
  p_premake         := 24,
  p_start_partition := '2025-01-01'
);

-- pg_partman v5 default retention is "keep everything". Explicit
-- here so a future operator who wants a retention policy knows
-- where the knob lives without having to dig through the upstream
-- docs. Set retention to NULL to keep the explicit "no expiry"
-- intent on record in part_config.
UPDATE partman.part_config
   SET retention = NULL
 WHERE parent_table = 'public.observation';

-- 6. Move existing data into the partitioned table. Each row routes
--    into its tx_time month partition automatically. At Phase 8
--    cutover time we have ~10s of rows in dev and similar in prod;
--    even a million-row table would copy in seconds inside a
--    transaction.
INSERT INTO observation
  (id, tx_time, valid_from, valid_to, scope, entity, kind,
   attrs, geom, cell, author_sub, source, parents)
SELECT
  id, tx_time, valid_from, valid_to, scope, entity, kind,
  attrs, geom, cell, author_sub, source, parents
FROM observation_pre_partition;

-- 7. Drop the old table. CASCADE catches anything dependent (none
--    expected; the renames preserved the column names + types).
DROP TABLE observation_pre_partition CASCADE;
