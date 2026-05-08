#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Idempotent post-deploy bootstrap that ensures the gratis-gis realm's
# user-profile schema declares the `org` and `org_role` attributes
# (#71). Without this, Keycloak 26 silently drops attempts to set
# those attributes on user create -- the portal-api code does the
# right thing but the schema rejects unknown fields, leaving new
# users with empty attributes and a JWT that's missing the `org`
# claim. First sign-in then 401s with "JWT is missing required org
# claim", which surfaces in the portal-web detail page as a
# Server-Component digest error.
#
# Safe to re-run: parses the current schema and only PUTs an updated
# copy when one of the two attributes is missing. Useful both as a
# one-shot fix on existing prod realms (the original deploy was
# already patched manually but a fresh restore-from-backup would
# regress) and as the canonical bootstrap step for any new
# environment.
#
# Usage:
#   KC_URL=https://auth.gratisgis.org \
#   KC_ADMIN_USER=admin \
#   KC_ADMIN_PASS=... \
#   KC_REALM=gratis-gis \
#   bash infra/keycloak/patch-user-profile-schema.sh
#
# Defaults match the prod deploy; pass overrides for staging /
# local. Returns non-zero if Keycloak is unreachable, the admin
# token can't be minted, or the PUT fails with anything other than
# 200 / 204.

set -euo pipefail

KC_URL="${KC_URL:-https://auth.gratisgis.org}"
KC_ADMIN_USER="${KC_ADMIN_USER:-admin}"
KC_ADMIN_PASS="${KC_ADMIN_PASS:-}"
KC_REALM="${KC_REALM:-gratis-gis}"

if [[ -z "${KC_ADMIN_PASS}" ]]; then
  echo "error: KC_ADMIN_PASS is required (master-realm admin password)" >&2
  exit 2
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl not found; install it before running this script" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq not found; install it before running this script" >&2
  exit 2
fi

# Mint a master-realm admin token. The user-profile endpoint requires
# realm-admin (or specifically manage-realm); the master-realm admin
# is the simplest principal that has both, mirroring what the manual
# fix in #69 / #70 used.
TOKEN_JSON=$(curl -sS \
  --fail-with-body \
  -X POST \
  "${KC_URL}/realms/master/protocol/openid-connect/token" \
  -d "client_id=admin-cli" \
  -d "username=${KC_ADMIN_USER}" \
  -d "password=${KC_ADMIN_PASS}" \
  -d "grant_type=password")
TOKEN=$(echo "${TOKEN_JSON}" | jq -r '.access_token // empty')
if [[ -z "${TOKEN}" ]]; then
  echo "error: could not mint admin token; response was:" >&2
  echo "${TOKEN_JSON}" >&2
  exit 3
fi

# Read the current user-profile schema. We add org / org_role only
# if either is missing, preserving everything else (a deployment
# may have its own custom attributes beyond ours).
SCHEMA=$(curl -sS \
  --fail-with-body \
  -H "Authorization: Bearer ${TOKEN}" \
  "${KC_URL}/admin/realms/${KC_REALM}/users/profile")

HAS_ORG=$(echo "${SCHEMA}" | jq '[.attributes[].name] | index("org") != null')
HAS_ORG_ROLE=$(echo "${SCHEMA}" | jq '[.attributes[].name] | index("org_role") != null')

if [[ "${HAS_ORG}" == "true" && "${HAS_ORG_ROLE}" == "true" ]]; then
  echo "user-profile schema already declares org + org_role; nothing to do."
  exit 0
fi

# Build the patched schema. The attribute spec mirrors what the
# manual fix used: edit permission limited to admin (so the
# portal-api admin-client write path works), view permission open
# to admin + user (so both the user themselves and the admin UI
# can read it), single-valued, no validations beyond presence.
PATCHED=$(echo "${SCHEMA}" | jq '
  .attributes |= (
    if any(.name == "org") then . else
      . + [{
        name: "org",
        displayName: "Organization",
        permissions: { view: ["admin", "user"], edit: ["admin"] },
        multivalued: false
      }]
    end
  ) |
  .attributes |= (
    if any(.name == "org_role") then . else
      . + [{
        name: "org_role",
        displayName: "Org role",
        permissions: { view: ["admin", "user"], edit: ["admin"] },
        multivalued: false
      }]
    end
  )
')

HTTP_CODE=$(curl -sS \
  -o /tmp/kc-patch-response.txt \
  -w "%{http_code}" \
  -X PUT \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data "${PATCHED}" \
  "${KC_URL}/admin/realms/${KC_REALM}/users/profile")

if [[ "${HTTP_CODE}" != "200" && "${HTTP_CODE}" != "204" ]]; then
  echo "error: PUT /users/profile returned HTTP ${HTTP_CODE}; response was:" >&2
  cat /tmp/kc-patch-response.txt >&2
  echo >&2
  exit 4
fi

echo "user-profile schema patched: org${HAS_ORG:+ already declared}, org_role${HAS_ORG_ROLE:+ already declared} added."
