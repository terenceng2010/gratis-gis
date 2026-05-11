-- Tamper-proof master-admin flag (#134). When true the admin API
-- refuses every mutation against this user: role change, enable
-- toggle, auto-disable, delete, password reset. There is no API
-- surface that flips this flag back; it can only be set via direct
-- DB access. This is the always-on defense that lets us open the
-- portal for public testing without giving a tester the ability to
-- take over the master admin.
--
-- Bootstrap: any user with `org_role = 'admin'` AND `username = 'admin'`
-- is auto-protected on migration apply. That's the seeded master
-- account on every realm we ship. If an org wants to protect a
-- DIFFERENT account, an admin can update the column directly in
-- psql:
--    UPDATE "user" SET is_protected = true WHERE username = 'foo';
ALTER TABLE "user" ADD COLUMN "is_protected" BOOLEAN NOT NULL DEFAULT false;

UPDATE "user"
SET "is_protected" = true
WHERE "username" = 'admin' AND "org_role" = 'admin';
