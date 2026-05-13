-- #22 fix: deduplicate seeded items + add a partial unique index
-- so the cross-container race in auth-sync's ensureBuiltin* path
-- cannot produce doubles again.
--
-- Root cause: portal-api runs two replicas behind the load
-- balancer.  Each replica has its own AuthSyncService instance
-- with its own in-process `Set<orgId>` of "already verified."
-- When a user's first authenticated requests land on both
-- replicas around the same time, each replica's seeder:
--   1. SELECTs `item WHERE seed_kind IS NOT NULL` for the org
--      and sees no matching rows
--   2. INSERTs the full starter set
-- Both INSERTs commit; the org now owns two copies of every
-- starter.  The in-process coalescing only stops the race
-- WITHIN one replica, not across replicas.
--
-- Step 1: collapse existing duplicates.  Keep the row with the
-- smallest created_at per (org, type, seed_kind); discard the
-- rest.  Only touches rows where seed_kind IS NOT NULL (the
-- starter-seeded rows) and that are not already trashed.

DELETE FROM "item"
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY org_id, type, seed_kind
        ORDER BY created_at ASC, id ASC
      ) AS rn
    FROM "item"
    WHERE seed_kind IS NOT NULL
      AND deleted_at IS NULL
  ) ranked
  WHERE rn > 1
);

-- Step 2: enforce one starter per (org, type, seed_kind) at the
-- DB level.  Partial index so it only covers seeded rows (the
-- column is nullable for everything else).  Excludes soft-deleted
-- rows so an admin can delete a starter and the seeder/restore
-- flow can later create a fresh one.

CREATE UNIQUE INDEX "item_org_type_seed_kind_unique"
  ON "item" ("org_id", "type", "seed_kind")
  WHERE "seed_kind" IS NOT NULL AND "deleted_at" IS NULL;
