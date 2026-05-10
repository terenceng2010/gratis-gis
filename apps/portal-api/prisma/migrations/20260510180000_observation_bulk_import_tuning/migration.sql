-- Phase 4 of the async import-jobs perf overhaul (#115). Two
-- bulk-import targeted index tweaks on the observation table.
--
-- 1. Drop observation_cell_idx.
--    The H3 cell column is computed in JS via h3-js and written on
--    every observation, but no read path queries it. Grepping the
--    api source for `WHERE.*cell` / `cell\s*=` returns zero hits
--    outside spec files. The index just costs btree maintenance on
--    every write (and on each of the 42 monthly partitions) for no
--    query-side payoff. Drop it now and reclaim the per-write cost.
--    The column itself stays so we can light up an index later if
--    cell-bucketed queries ever become real.
--
-- 2. Tune observation_attrs_gin for bulk-load throughput.
--    Default GIN fastupdate=on with gin_pending_list_limit=4MB
--    means a county-scale ingest flushes the pending list ~hundreds
--    of times. Bump to 64MB so pending-list flushes happen on the
--    order of single-digits per import. Trade-off: queries that
--    hit the pending list scan it linearly, so a SELECT issued
--    mid-import sees a slight slowdown until autovacuum or
--    gin_clean_pending_list() drains the list. Acceptable: the
--    existing usage pattern is bursts of writes, then idle reads,
--    and the import-jobs worker isn't read-hot anyway.
--
-- The DO block applies the storage parameter both to the parent
-- partitioned-index AND each child (one per partition). Postgres
-- does NOT propagate ALTER INDEX SET storage parameters from a
-- partitioned index to its children, so we do it explicitly.

-- 1. Drop unused cell index.
DROP INDEX IF EXISTS observation_cell_idx;

-- 2. Tune attrs GIN fastupdate. Apply to the parent and every child.
ALTER INDEX observation_attrs_gin
  SET (fastupdate = on, gin_pending_list_limit = 65536);

DO $$
DECLARE
  child_oid OID;
  child_name TEXT;
BEGIN
  FOR child_oid, child_name IN
    SELECT inhrelid::regclass::oid, inhrelid::regclass::text
      FROM pg_inherits
     WHERE inhparent = 'observation_attrs_gin'::regclass
  LOOP
    EXECUTE format(
      'ALTER INDEX %s SET (fastupdate = on, gin_pending_list_limit = 65536)',
      child_name
    );
  END LOOP;
END $$;
