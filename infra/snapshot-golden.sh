#!/usr/bin/env bash
# Capture a "golden state" snapshot of the running GratisGIS prod
# stack. Used to seed the daily reset for the public test instance
# (#138). Run this ONCE, after setting up the demo content the way
# testers should always land in: e.g. WV parcels imported, a couple
# of example maps and dashboards created, the three test users
# provisioned, no garbage.
#
# What gets captured:
#   - The `gratisgis` Postgres database  (items, users, observations,
#     shares, folders, etc).
#   - The `keycloak` Postgres database  (realm config, the three
#     test users, password hashes, client secrets).
#   - The `miniodata` Docker volume  (feature attachments, avatars,
#     basemap thumbnails, item thumbnails, exports).
#
# What does NOT get captured:
#   - `caddy-data`, `caddy-config` (TLS certs, ACME state). Reset is
#     not allowed to interrupt those.
#   - `gg-staging`, `portal-api-backups` (ephemeral; recreated on
#     next use).
#   - Container images, env files.
#
# Brief downtime: dependent services are stopped during capture to
# guarantee Postgres + MinIO are consistent with each other. Plan on
# 30 - 60 seconds.
#
# Usage:
#   sudo ./infra/snapshot-golden.sh
#
# Artifacts land in /var/lib/gratis-gis-golden/. The restore script
# reads from the same path.
set -euo pipefail

GOLDEN_DIR="/var/lib/gratis-gis-golden"
COMPOSE_PROJECT="gratis-gis-prod"
INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$INFRA_DIR/docker-compose.prod.yml"
ENV_FILE="$INFRA_DIR/.env.prod"

if [[ $EUID -ne 0 ]]; then
  echo "FATAL: snapshot-golden.sh must run as root (needs docker volume access)." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "FATAL: $ENV_FILE missing. Snapshot needs the prod env to know DB credentials." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

POSTGRES_USER="${POSTGRES_USER:-gratisgis}"
POSTGRES_DB_APP="${POSTGRES_DB:-gratisgis}"
KEYCLOAK_DB_NAME="${KEYCLOAK_DB_NAME:-keycloak}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"

mkdir -p "$GOLDEN_DIR"
chmod 700 "$GOLDEN_DIR"

dc() {
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

# Pre-snapshot cleanup. The public demo accounts (tester-admin /
# tester-contributor / tester-viewer) sit behind the gratisgis.org
# landing banner so anyone can sign in as them; whatever they
# create between snapshots would otherwise get baked into the
# golden state and survive every nightly reset forever. Purge any
# item not owned by the bootstrap admin before pg_dump captures
# the DB.
#
# Runs via the portal-api container so item teardown routes through
# the normal ItemsService.purge path (drops per-layer feature
# tables, removes MinIO blobs, cleans observation partitions).
# SQL-only deletion would leave those as orphans in the MinIO
# tarball and bloat every future snapshot by 50-100MB of dead
# bytes.
#
# Failure mode: if the admin token can't be obtained (Keycloak
# down, INITIAL_USER_PASSWORD rotated without updating .env.prod)
# the script fails closed and aborts the snapshot. Without the
# admin id we can't tell who NOT to purge, and silently snapshotting
# a polluted DB is worse than refusing to snapshot at all.
if [[ -z "${INITIAL_USER_PASSWORD:-}" ]]; then
  echo "FATAL: INITIAL_USER_PASSWORD missing from .env.prod -- can't sign in as bootstrap admin to run pre-snapshot cleanup." >&2
  exit 1
fi
echo "=== Pre-snapshot purge of non-admin items ==="
PORTAL_API_CONTAINER="$(dc ps -q portal-api 2>/dev/null | head -n 1)"
if [[ -z "$PORTAL_API_CONTAINER" ]]; then
  echo "FATAL: portal-api container not running; cannot purge non-admin items before snapshot." >&2
  exit 1
fi
docker cp "$INFRA_DIR/cleanup-non-admin.mjs" \
  "${PORTAL_API_CONTAINER}:/tmp/cleanup-non-admin.mjs"
docker exec \
  -e ADMIN_PWD="$INITIAL_USER_PASSWORD" \
  -e ADMIN_USERNAME="$ADMIN_USERNAME" \
  "$PORTAL_API_CONTAINER" \
  node /tmp/cleanup-non-admin.mjs
# Cleanup the staged script. `docker cp` plants the file as root,
# but the container's default user is `app` (uid 999), so a plain
# `docker exec ... rm` fails with EPERM. Use -u 0 to remove as root.
# `|| true` belt-and-suspenders in case the container is somehow
# already gone -- a leftover /tmp file is harmless, an aborted
# snapshot isn't.
docker exec -u 0 "$PORTAL_API_CONTAINER" \
  rm -f /tmp/cleanup-non-admin.mjs || true

echo "=== Stopping app services for consistent snapshot ==="
# Stop in dependency order; postgres stays up so we can pg_dump.
dc stop portal-api portal-worker portal-web keycloak

echo "=== Dumping Postgres: $POSTGRES_DB_APP ==="
dc exec -T postgres pg_dump \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB_APP" \
  -F c -Z 6 \
  > "$GOLDEN_DIR/postgres-app.dump"

echo "=== Dumping Postgres: $KEYCLOAK_DB_NAME ==="
dc exec -T postgres pg_dump \
  -U "$POSTGRES_USER" \
  -d "$KEYCLOAK_DB_NAME" \
  -F c -Z 6 \
  > "$GOLDEN_DIR/postgres-keycloak.dump"

echo "=== Snapshotting MinIO volume ==="
# Run a throwaway alpine container with both the minio volume and
# the golden dir mounted; tar the volume contents out. Faster +
# more reliable than docker cp for a directory tree of arbitrary
# size, and atomic from the file-system layer's point of view
# because nothing is writing the volume while minio is stopped.
# Actually MinIO is still up here (it's needed for /api/portal
# attachment serves to work even when api is stopped during a
# write, and stopping it briefly while the app services are also
# stopped is fine). Stop minio too:
dc stop minio
docker run --rm \
  -v "${COMPOSE_PROJECT}_miniodata":/data:ro \
  -v "$GOLDEN_DIR":/out \
  alpine:3.20 \
  tar czf /out/minio.tar.gz -C /data .

echo "=== Restarting app services ==="
dc start minio
# Wait a beat for minio to be ready before app services start hitting it.
sleep 3
dc start keycloak portal-web portal-worker portal-api

echo "=== Snapshot complete ==="
ls -lh "$GOLDEN_DIR"
echo ""
echo "Restore reads from $GOLDEN_DIR. Test it once before relying"
echo "on the cron, with:"
echo "    sudo PORTAL_PUBLIC_TESTING=1 $(dirname "${BASH_SOURCE[0]}")/restore-golden.sh"
