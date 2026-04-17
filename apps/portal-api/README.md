# @gratis-gis/portal-api

The NestJS backend for GratisGIS. See [/ARCHITECTURE.md](../../ARCHITECTURE.md)
for the big picture.

## Run locally

```bash
# From repo root, first bring up infra:
pnpm infra:up

# Generate prisma client + run migrations (first time):
pnpm --filter @gratis-gis/portal-api db:generate
pnpm --filter @gratis-gis/portal-api db:migrate

# Seed the dev org + users + a sample item:
pnpm --filter @gratis-gis/portal-api db:seed

# Start the API:
pnpm --filter @gratis-gis/portal-api dev
# → http://localhost:4000
# → http://localhost:4000/docs  (Swagger UI)
# → http://localhost:4000/health
```

## Layout

```
src/
├── main.ts             Bootstraps Nest + Swagger
├── app.module.ts       Root module (registers everything)
├── health.controller.ts
├── prisma/             Prisma client wrapper
├── auth/               Keycloak JWT strategy + guard + user sync
├── users/              /users/me
├── groups/             CRUD + membership
└── items/              CRUD + sharing, the single source of truth for
                        access decisions (sharing.service.ts)
```

## Access decisions

Every item read/write goes through `items/sharing.service.ts`. If you're
touching sharing, there's one place to look.

## Testing

```bash
pnpm --filter @gratis-gis/portal-api test
```

(E2E tests against a real Postgres + Keycloak are added in phase 1.)
