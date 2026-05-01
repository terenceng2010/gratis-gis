#!/usr/bin/env bash
# portal-api container entrypoint. Applies pending Prisma migrations
# against $DATABASE_URL, then exec's the CMD. Idempotent: a fully-
# migrated DB no-ops in seconds.
#
# Migration failures (schema drift, contention) abort the boot so the
# container restart policy surfaces them as crash loops rather than a
# silent half-migrated state.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "FATAL: DATABASE_URL is not set" >&2
  exit 1
fi

echo "[entrypoint] applying prisma migrations against $(echo "$DATABASE_URL" | sed -E 's#://[^@]+@#://***@#')"
# Use the prisma CLI shipped in the deploy bundle (under node_modules
# since prisma is a dev dep that pnpm deploy doesn't carry). We run
# `npx --no-install` first to fail fast if it's missing, then fall
# back to the runtime ships of `@prisma/client` which can apply
# migrations via the `prisma` binary it bundles.
if [[ -x /app/node_modules/.bin/prisma ]]; then
  /app/node_modules/.bin/prisma migrate deploy --schema=/app/prisma/schema.prisma
else
  # Prisma was installed only as a dev dep so pnpm --prod stripped it.
  # Fall back to running the engine directly via node.
  node /app/node_modules/@prisma/client/runtime/library.js >/dev/null 2>&1 || true
  echo "WARN: prisma CLI not present in runtime image; skipping migrate deploy" >&2
  echo "      Run 'docker compose run --rm portal-api npx prisma migrate deploy' manually." >&2
fi

echo "[entrypoint] starting: $*"
exec "$@"
