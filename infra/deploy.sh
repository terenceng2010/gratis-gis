#!/usr/bin/env bash
# One-shot deploy of the gratisgis.org production stack. Idempotent:
# safe to re-run after every git pull. Run from the repo root on the
# deploy host.
#
#   ./infra/deploy.sh
#
# What it does:
#   1. Sanity-checks that infra/.env.prod exists.
#   2. Builds the portal-api + portal-web images from source.
#   3. Rolls the stack with `docker compose up -d`. Containers whose
#      image / config didn't change keep running.
#   4. Tails recent logs so you can see whether the boot was clean.
#
# Migrations: the portal-api container's entrypoint runs `prisma
# migrate deploy` on every start, so a normal `up -d` is enough to
# apply pending schema changes. There's no separate migrate step.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f infra/.env.prod ]]; then
  echo "FATAL: infra/.env.prod is missing." >&2
  echo "Copy infra/.env.prod.example to infra/.env.prod and fill in real values." >&2
  exit 1
fi

# All the GENERATE placeholders have to be replaced before deploy or
# Keycloak / Postgres / NextAuth will refuse to start.
if grep -q '^[A-Z_]*=GENERATE$' infra/.env.prod; then
  echo "FATAL: infra/.env.prod still contains GENERATE placeholders:" >&2
  grep '^[A-Z_]*=GENERATE$' infra/.env.prod >&2
  echo "Run: openssl rand -base64 36   to generate strong values for each." >&2
  exit 1
fi

# Materialize the Keycloak realm import file from the template by
# substituting env vars. envsubst only replaces $VAR / ${VAR} forms,
# leaving JSON braces alone. Run it before bringing keycloak up so
# the import directory is ready when the container starts.
echo "=== Materializing Keycloak realm import ==="
mkdir -p infra/keycloak/import
# shellcheck disable=SC1091
set -a
. infra/.env.prod
# Derived AUTH_URL the realm template uses for the realm-level
# frontendUrl. Keep this separate from PUBLIC_URL: the realm has to
# advertise itself as the AUTH subdomain (otherwise discovery
# returns the wrong issuer and OAuth breaks).
export AUTH_URL="https://${AUTH_DOMAIN:-auth.gratisgis.org}"
set +a
envsubst < infra/keycloak/realm-gratis-gis.prod.json.tmpl \
  > infra/keycloak/import/realm-gratis-gis.json
# Sanity-check: the JSON should still parse after substitution.
python3 -c "import json,sys; json.load(open('infra/keycloak/import/realm-gratis-gis.json'))" \
  || { echo "FATAL: realm import JSON is malformed after envsubst" >&2; exit 1; }
echo "Wrote infra/keycloak/import/realm-gratis-gis.json"

COMPOSE=(docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod)

echo "=== Building images ==="
"${COMPOSE[@]}" build

echo "=== Bringing up stack ==="
"${COMPOSE[@]}" up -d

echo "=== Status ==="
"${COMPOSE[@]}" ps

echo
echo "=== Tail of recent logs (last 30 lines per service) ==="
"${COMPOSE[@]}" logs --tail=30
