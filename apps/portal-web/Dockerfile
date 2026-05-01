# GratisGIS portal-web production image. Multi-stage:
#
#   - build: pnpm install + next build (output: standalone) at the
#     repo root so workspace deps (shared-types, ui, form-schema)
#     resolve. Next's tracer collects the runtime subset.
#   - runtime: node:20-slim with the standalone server, public assets,
#     and prebuilt static chunks. Tiny image, no pnpm or build chain.
#
# Built from the repo root:  docker build -f apps/portal-web/Dockerfile .

FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/portal-web ./apps/portal-web
# portal-web pulls in shared types from form-schema's index too (some
# pages render form schemas server-side).
RUN pnpm install --frozen-lockfile

# Telemetry is a noisy build-time stderr; not useful here.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm -C apps/portal-web build

FROM base AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r app && useradd -r -g app -m -d /home/app app

# Standalone output. Next's tracer roots at /repo (outputFileTracingRoot
# in next.config.mjs) so the standalone tree mirrors that prefix; we
# flatten it back to /app here. The first COPY brings the server.js +
# minimal node_modules. The next two pull in /public and /.next/static
# which the standalone server can't include but expects to find at
# their original paths.
COPY --from=build --chown=app:app /repo/apps/portal-web/.next/standalone /app
COPY --from=build --chown=app:app /repo/apps/portal-web/public /app/apps/portal-web/public
COPY --from=build --chown=app:app /repo/apps/portal-web/.next/static /app/apps/portal-web/.next/static

USER app
EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:3000/ || exit 1

# The standalone server lives at <package>/server.js relative to the
# tracing root. Our root is the repo, so the server lands at
# /app/apps/portal-web/server.js.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/portal-web/server.js"]
