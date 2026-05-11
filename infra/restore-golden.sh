#!/usr/bin/env bash
# Restore the GratisGIS prod stack to the captured golden state.
# Used by the daily public-testing-mode reset cron (#138). Run
# manually for testing; otherwise the systemd timer
# `gg-reset-demo.timer` invokes it at 04:00 UTC daily.
#
# What gets restored:
#   - `gratisgis` Postgres database  (drop + restore from
#     /var/lib/gratis-gis-golden/postgres-app.dump).
#   - `keycloak` Postgres database  (same, from
#     /var/lib/gratis-gis-golden/postgres-keycloak.dump).
#   - `miniodata` Docker volume contents  (wipe + untar from
#     /var/lib/gratis-gis-golden/minio.tar.gz).
#
# What does NOT get restored:
#   - TLS / ACME state (caddy-data, caddy-config). Reset never
#     touches certs; reissuing them takes minutes and rate-limits
#     hit fast.
#   - The /var/lib/gratis-gis-golden/ snapshot itself. It is read-
#     only as far as this script is concerned.
#
# Safety gate: this script REFUSES to run unless
# `PORTAL_PUBLIC_TESTING` is truthy. Without that gate, a stray cron
# trigger on a normal-use deploy would silently destroy real data.
#
# Brief downtime: ~30 - 60 seconds. The script stops app services,
# wipes the live DBs and the live MinIO volume, restores from the
# snapshot, and restarts services. Caddy stays up the entire time,
# so users see a brief 502 (which Caddy returns as its own polite
# error page) rather than a connection error.
set -euo pipefail

GOLDEN_DIR="/var/lib/gratis-gis-golden"
COMPOSE_PROJECT="gratis-gis-prod"
COMPOSE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/docker-compose.prod.yml"
ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.env.prod"
LOG_FILE="/var/log/gg-reset-demo.log"

# Mirror stdout + stderr into a rolling log; systemd-journal also
# captures the unit's output, but the file is the durable record
# the operator can `tail -F` when triaging a failed reset.
exec > >(tee -a "$LOG_FILE") 2>&1
echo ""
echo "=== Reset run at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

if [[ $EUID -ne 0 ]]; then
  echo "FATAL: restore-golden.sh must run as root (docker + volume access)." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "FATAL: $ENV_FILE missing." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Safety gate. The check is intentionally permissive (any truthy
# string) so an operator can pass it ad hoc on the command line
# during testing. The systemd unit sets it explicitly via
# Environment= so the timer doesn't need the env file to carry it.
TESTING_FLAG="${PORTAL_PUBLIC_TESTING:-}"
case "${TESTING_FLAG,,}" in
  1|true|yes|on)
    ;;
  *)
    echo "FATAL: PORTAL_PUBLIC_TESTING is not set in the env." >&2
    echo "       Refusing to wipe the live stack on a non-testing deploy." >&2
    exit 1
    ;;
esac

# Confirm snapshot artifacts exist before doing anything destructive.
# Bailing here is the operator-friendly mode: the live stack stays
# up, and the operator gets a clear error pointing at the missing
# file. If we deleted the live DB first and THEN noticed the snapshot
# was incomplete, we'd be in a much worse spot.
for f in postgres-app.dump postgres-keycloak.dump minio.tar.gz; do
  if [[ ! -s "$GOLDEN_DIR/$f" ]]; then
    echo "FATAL: snapshot artifact missing or empty: $GOLDEN_DIR/$f" >&2
    echo "       Run infra/snapshot-golden.sh first to seed the golden state." >&2
    exit 1
  fi
done

POSTGRES_USER="${POSTGRES_USER:-gratisgis}"
POSTGRES_DB_APP="${POSTGRES_DB:-gratisgis}"
KEYCLOAK_DB_NAME="${KEYCLOAK_DB_NAME:-keycloak}"

dc() {
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

# Postgres + DB role for the keycloak DB owner. Init-prod-db.sh
# (run on first postgres-container boot) creates a separate
# `keycloak` role; that role survives the DB drop because it's a
# server-level role, not a per-DB object. Same for the `gratisgis`
# role.
KEYCLOAK_DB_USER="${KEYCLOAK_DB_USER:-keycloak}"

drop_and_restore() {
  local db="$1"
  local owner="$2"
  local dump="$3"

  echo "--- Restoring database: $db (owner=$owner) ---"

  # Disconnect any active sessions so DROP DATABASE doesn't block.
  # ALTER DATABASE ... CONNECTION LIMIT 0 prevents new connections
  # from forming during this; pg_terminate_backend kills any
  # already-open ones.
  dc exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
    psql -U postgres -d postgres -c "ALTER DATABASE \"$db\" CONNECTION LIMIT 0;" \
    || true
  dc exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
    psql -U postgres -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$db' AND pid <> pg_backend_pid();" \
    || true

  dc exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
    psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS \"$db\";"
  dc exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
    psql -U postgres -d postgres -c "CREATE DATABASE \"$db\" OWNER \"$owner\";"

  # Restore the dump. --no-owner + --role lets the restore re-grant
  # objects to the correct owner regardless of who they were owned
  # by at dump time.
  cat "$dump" | dc exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
    pg_restore -U postgres -d "$db" --no-owner --role="$owner" --clean --if-exists
}

echo "=== Stopping app services ==="
dc stop portal-api-1 portal-api-2 portal-worker portal-web keycloak

echo "=== Restoring Postgres databases ==="
drop_and_restore "$POSTGRES_DB_APP" "$POSTGRES_USER" "$GOLDEN_DIR/postgres-app.dump"
drop_and_restore "$KEYCLOAK_DB_NAME" "$KEYCLOAK_DB_USER" "$GOLDEN_DIR/postgres-keycloak.dump"

echo "=== Restoring MinIO volume ==="
# Stop minio so nothing writes the volume while we swap its contents.
dc stop minio
docker run --rm \
  -v "${COMPOSE_PROJECT}_miniodata":/data \
  -v "$GOLDEN_DIR":/in:ro \
  alpine:3.20 \
  sh -c 'rm -rf /data/..?* /data/.[!.]* /data/* && tar xzf /in/minio.tar.gz -C /data'
dc start minio

echo "=== Restarting app services ==="
# Give minio + postgres a couple of seconds to settle before app
# services start hitting them.
sleep 3
dc start keycloak
sleep 5  # Keycloak boot is slower than postgres / minio.
dc start portal-web portal-worker portal-api-1 portal-api-2

echo "=== Reset complete at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo ""
