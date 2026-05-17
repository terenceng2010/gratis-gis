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
COMPOSE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/docker-compose.prod.yml"
ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.env.prod"

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

mkdir -p "$GOLDEN_DIR"
chmod 700 "$GOLDEN_DIR"

dc() {
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

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
