-- Runs once, on first postgres container boot in PRODUCTION.
-- See init-prod-db.sh for the Keycloak role + database creation
-- (split out so we can pass the password via psql -v).
--
-- This file just sets up the GratisGIS app DB extensions, identical
-- to init-db.sql. Kept separate so the prod stack and dev stack can
-- diverge later (e.g. tighter pg_hba defaults, different schemas)
-- without one rebasing the other.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS tiles;
GRANT USAGE ON SCHEMA tiles TO gratisgis;
