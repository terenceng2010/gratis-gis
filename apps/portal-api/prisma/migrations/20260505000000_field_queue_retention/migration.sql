-- #276: field-queue retention settings on the housekeeping_config
-- singleton. Three columns:
--
--   field_queue_stale_days: how many days an empty manifest can sit
--     idle before the admin UI hides it by default + the bulk-forget
--     button considers it stale. Null falls back to a 7-day default
--     in code.
--
--   field_queue_auto_prune_enabled: whether the scheduled
--     housekeeping pass should also delete rows matching the same
--     "empty + idle" criteria past the grace window. Off by default
--     so a fresh portal never silently drops state.
--
--   field_queue_auto_prune_grace_days: extra cushion past the stale
--     threshold the cron must observe before actually deleting. So
--     with the defaults (stale=7, grace=90), the cron only touches
--     rows that have been empty + silent for 97+ days, well past
--     any reasonable "left my phone in a drawer" recovery window.
--     Null falls back to a 90-day default in code.

ALTER TABLE "housekeeping_config"
  ADD COLUMN "field_queue_stale_days" INTEGER,
  ADD COLUMN "field_queue_auto_prune_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "field_queue_auto_prune_grace_days" INTEGER;
