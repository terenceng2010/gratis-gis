-- Last-seen timestamp on users. Drives the stale-user heuristic on
-- /admin/housekeeping. Populated lazily by AuthSyncService on every
-- authenticated request, so existing users start as NULL and get
-- stamped the next time they sign in.
ALTER TABLE "user"
  ADD COLUMN "last_seen_at" TIMESTAMP(3);
