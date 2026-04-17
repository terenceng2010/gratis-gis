# @gratis-gis/portal-web

Next.js 14 (App Router) UI for the GratisGIS portal. Signs in via Keycloak
using `next-auth` and talks to `portal-api` with the user's access token.

## Run locally

```bash
# Infra and portal-api must be running (see root README)
pnpm --filter @gratis-gis/portal-web dev
# → http://localhost:3000
```

## Layout

```
src/
├── app/
│   ├── layout.tsx              Root layout + providers
│   ├── providers.tsx           next-auth SessionProvider
│   ├── page.tsx                Home: tiles + sign-in button
│   ├── items/page.tsx          Items listing
│   ├── groups/page.tsx         Groups listing
│   └── api/auth/[...nextauth]/ next-auth route handler (Keycloak)
└── lib/
    ├── auth.ts                 next-auth options + Keycloak provider
    └── api.ts                  Server-side fetch wrapper that forwards JWT
```

## Auth flow

`next-auth` handles the OIDC round-trip with Keycloak. The resulting access
token is stored on the session and forwarded to `portal-api` for every
server-component data fetch. Client components that need to call the API
should do so via an internal Next.js route handler to avoid exposing the
token to the browser (TBD in phase 1).
