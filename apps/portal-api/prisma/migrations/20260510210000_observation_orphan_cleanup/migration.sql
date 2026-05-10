-- One-shot orphan cleanup for the observation table (#115 P11).
--
-- Two classes of garbage rows accumulated up to today:
--
--   1. Pre-fix item purges: ItemsService.purge() did NOT delete
--      observations whose scope referenced the item (the inline
--      comment that previously said "Phase 2.6's migration will
--      sweep them" never actually shipped). So every permanently-
--      deleted v3 data_layer left its features sitting in
--      observation.
--
--   2. Pre-fix import-job cancels: ImportJobsWorker.runJob() called
--      writer.end() (= COMMIT) when the job was cancelled mid-
--      stream, instead of writer.abort() (= ROLLBACK). So every
--      cancelled-mid-flight import committed its partial rows. On
--      prod-as-of-today this leaked ~1.3M rows from two cancelled
--      runs (ccbc4e43:lyr_d7tp0mv3 = 825k, 6e035d20:tbl_wgzwcqby
--      = 500k).
--
-- Both buckets are reachable via the same query: scope shape is
-- `data_layer:<itemId>:<layerId>`, so any scope whose itemId isn't
-- in the `item` table belongs to a deleted-or-never-existed item
-- and can be deleted.
--
-- We DELETE rather than DROP partition because partitions span
-- months of valid data; we just want to remove orphan rows.
-- Reclaiming the disk freed by these deletes is a separate step
-- (pg_repack on observation_p20xxxxxx); without it, autovacuum
-- only marks pages as reusable, it doesn't shrink the file.

-- Capture stats so the migration log shows what it actually did.
DO $$
DECLARE
  orphan_rows BIGINT;
BEGIN
  SELECT COUNT(*) INTO orphan_rows
    FROM observation
   WHERE scope LIKE 'data_layer:%'
     AND substring(scope FROM 12 FOR 36) NOT IN (
       SELECT id::text FROM item
     );
  RAISE NOTICE 'observation orphan-cleanup: % rows match', orphan_rows;
END $$;

-- Delete the orphans. Postgres routes the delete into the right
-- partitions automatically. The substring math (12 FOR 36) skips
-- the literal `data_layer:` prefix and grabs the 36-char UUID.
DELETE FROM observation
WHERE scope LIKE 'data_layer:%'
  AND substring(scope FROM 12 FOR 36) NOT IN (
    SELECT id::text FROM item
  );

-- ANALYZE so the planner has fresh stats after the bulk delete.
-- Cheap; avoids surprising plan regressions on the next read.
ANALYZE observation;
