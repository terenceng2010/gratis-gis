# GratisGIS portal-api production image. Multi-stage:
#
#   - build: pnpm install + prisma generate + nest build, run from
#     repo root so the workspace dependencies (shared-types,
#     form-schema) resolve cleanly. We deploy the api workspace to a
#     self-contained /out directory via `pnpm deploy --prod` so the
#     runtime image only carries what's needed.
#   - runtime: node:20 + GDAL + OpenSSL only. Drops the build chain
#     and dev deps. Runs as a non-root `app` user.
#
# Built from the repo root so the build context can see the whole
# monorepo:  docker build -f apps/portal-api/Dockerfile .

FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /repo
# Build deps: gdal-async, prisma, and the @nestjs/cli all need build
# tools at install/generate time. Removed in the runtime stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      build-essential \
      pkg-config \
      libgdal-dev \
      gdal-bin \
      openssl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Layer caching: copy lockfile-relevant files first so pnpm install
# only re-runs when deps actually change.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
# pnpm's --frozen-lockfile expects EVERY workspace package referenced
# in the lockfile to exist in the tree. Copying the full apps/ subtree
# is the simplest way to satisfy that without per-package COPY juggling.
# .dockerignore on each app strips the heavy stuff (node_modules,
# .next, dist), so the build context stays small.
COPY apps ./apps

RUN pnpm install --frozen-lockfile

# Prisma client (generated into node_modules/.prisma/client) and the
# Nest build (dist/) both happen here.
RUN pnpm -C apps/portal-api exec prisma generate
RUN pnpm -C apps/portal-api build

# Carve out a self-contained directory for the runtime stage. pnpm
# deploy follows the workspace links and produces a flat node_modules
# we can copy into a clean image. We deliberately keep dev deps
# because the prisma CLI lives there and we run `prisma migrate
# deploy` from the entrypoint at boot.
RUN pnpm deploy --filter=@gratis-gis/portal-api /out

FROM base AS runtime
WORKDIR /app
# Runtime deps for GDAL, the Prisma engine, and TLS. No build chain.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgdal-dev \
      gdal-bin \
      openssl \
      ca-certificates \
      curl \
      tini \
    && rm -rf /var/lib/apt/lists/*

# Drop privileges. Postgres connections, file uploads, and GDAL all
# work fine for a non-root user.
RUN groupadd -r app && useradd -r -g app -m -d /home/app app

COPY --from=build --chown=app:app /out /app
# Prisma migrations live alongside schema.prisma and aren't part of the
# deploy output. Mount them in by hand so `prisma migrate deploy` works
# from this image.
COPY --from=build --chown=app:app /repo/apps/portal-api/prisma /app/prisma

# Entrypoint: apply migrations, then start. Idempotent on a current
# DB (no-op when nothing pending). Surfaces migration errors as exit
# codes so the container fails fast on a bad deploy.
COPY --chown=app:app apps/portal-api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER app
EXPOSE 4000
ENV NODE_ENV=production
ENV PORT=4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://localhost:4000/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
