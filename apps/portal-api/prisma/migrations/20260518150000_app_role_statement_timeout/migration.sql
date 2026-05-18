-- Apply a 30-second statement_timeout to the application DB role so
-- a single pathological query (eg a huge user-supplied geometry
-- intersected against the whole feature set) cannot tie up a
-- connection indefinitely.
--
-- The role name has to match whatever role POSTGRES_USER resolves to
-- at infra/.env (default `gratisgis`).  The DO block lets the
-- migration be idempotent across local and prod where the DB role
-- might be created with a different name; if the expected role does
-- not exist we no-op rather than failing the deploy.
--
-- 30 seconds is enough headroom for the legitimate slow paths
-- (vector tile builds against large layers, bbox queries during
-- the housekeeping recompute pass) while still bounding the impact
-- of a runaway query.  Tune via a follow-up migration if needed.
--
-- Note: the timeout applies to new sessions only.  Existing
-- connections will pick it up on the next reconnect.  Prisma's
-- connection pool turns over quickly so this is effectively
-- immediate at the application layer.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user) THEN
        EXECUTE format(
            'ALTER ROLE %I SET statement_timeout = %L',
            current_user,
            '30s'
        );
    END IF;
END
$$;
