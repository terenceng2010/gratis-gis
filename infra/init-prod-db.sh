#!/usr/bin/env bash
# Runs once, on first postgres container boot in PRODUCTION. Creates a
# `keycloak` role + database for the Keycloak service, with the
# password sourced from KEYCLOAK_DB_PASSWORD in the container env (set
# by docker-compose). The official postgres image executes every
# *.sh in /docker-entrypoint-initdb.d after the *.sql files have
# already run, so the GratisGIS extensions from init-prod-db.sql are
# already in place by the time we get here.
#
# Idempotent: skips role/db creation if either already exists. That
# matters if the container is re-initialized against an existing
# volume (rare, but the volume key changes if compose names change).
set -euo pipefail

if [[ -z "${KEYCLOAK_DB_PASSWORD:-}" ]]; then
  echo "FATAL: KEYCLOAK_DB_PASSWORD must be set in the postgres container env" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     -v kc_pw="'${KEYCLOAK_DB_PASSWORD}'" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'keycloak') THEN
    EXECUTE format('CREATE ROLE keycloak LOGIN PASSWORD %s', :kc_pw);
  END IF;
END$$;

SELECT 'CREATE DATABASE keycloak OWNER keycloak'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'keycloak')\gexec
SQL

echo "[init-prod-db.sh] keycloak role + database ready"
