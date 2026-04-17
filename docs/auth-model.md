# Auth Model

## Identity provider: Keycloak

Keycloak is the source of truth for authentication. It handles sign-up,
sign-in, password reset, 2FA, social login, and SSO. GratisGIS apps never
see passwords.

### Realm + Clients

Realm: `gratis-gis`

Clients:

| client-id | kind | used by |
| --- | --- | --- |
| `portal-web` | public (PKCE) | Next.js portal frontend |
| `portal-api` | bearer-only | NestJS API (validates JWTs) |
| `field-app` | public (PKCE, native redirect) | React Native field app |

## Token Flow

1. User clicks "Sign in" in `portal-web`.
2. `next-auth` redirects to Keycloak's authorization endpoint (PKCE).
3. On return, `next-auth` exchanges the code for an access + refresh token.
4. `portal-web` server components forward the access token to `portal-api`
   as `Authorization: Bearer <jwt>`.
5. `portal-api` validates the JWT signature against Keycloak's JWKS and
   extracts claims.

## Required JWT Claims

| claim | meaning |
| --- | --- |
| `sub` | Keycloak user id: becomes `user.id` |
| `preferred_username` | → `user.username` |
| `email` | → `user.email` |
| `name` | → `user.full_name` |
| `org` (custom) | Organization slug: mapped to `user.org_id` at first login |
| `org_role` (custom) | `viewer` \| `publisher` \| `admin` |

Org assignment and org-role are set in Keycloak via user attributes; the
portal-api `auth.service` looks them up and upserts the local `User` row on
each login.

## Authorization in the API

NestJS uses a global `JwtAuthGuard` (backed by `passport-jwt`). Each request
gets a typed `AuthUser` injected:

```ts
type AuthUser = {
  id: string;        // user.id
  orgId: string;
  orgRole: 'viewer' | 'publisher' | 'admin';
  groupIds: string[]; // cached per request, resolved from DB
};
```

Access decisions are delegated to `sharing.service.canRead(user, item)` etc.,
implementing the algorithm in `data-model.md`.

## Session Security

- Access token TTL: 5 minutes
- Refresh token TTL: 1 day (web), 30 days (field app)
- Field app tokens bind to device-id claim; revocable per device
- CSRF: `portal-web` uses `next-auth`'s built-in CSRF protection for its
  own routes; API calls carry bearer tokens (not cookies), so no CSRF
  concern on the API.

## Offline Auth (field app)

The field app caches a short-lived offline token plus the last-synced user
snapshot. While offline, the app verifies the token signature against a
cached JWKS (refreshed on every online start). Once expired, the user must
come online to refresh.

## Future

- SAML realm aliases for enterprise SSO
- API keys for machine-to-machine access (separate table, scoped to org)
- Audit log for admin actions
