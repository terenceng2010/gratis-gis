#!/usr/bin/env bash
# Provision the three documented test users on the public test
# instance (#139). Pairs with PORTAL_LOCK_ADMIN_TIER + the master-
# admin protection flag: testers can sign in as tester-admin and
# poke at every admin surface, but they cannot mint new admins and
# they cannot touch the protected master `admin` account.
#
# The three users:
#
#   tester-admin       / Admin123!         org_role=admin
#   tester-contributor / Contributor123!   org_role=contributor
#   tester-viewer      / Viewer123!        org_role=viewer
#
# These passwords are intentionally simple and documented openly on
# the public-landing banner. Anyone who can read the banner can sign
# in; that's the point.
#
# IMPORTANT: this script provisions the users into the LIVE prod
# realm via the Keycloak admin REST API. After running it once,
# capture the snapshot with `snapshot-golden.sh` so the daily reset
# restores these accounts every day. Re-running this script is
# idempotent: existing users are updated, not duplicated.
#
# Usage:
#   sudo ./infra/seed-test-users.sh
set -euo pipefail

ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.env.prod"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "FATAL: $ENV_FILE missing." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Keycloak admin endpoints. KEYCLOAK_URL is the public-facing URL
# (https://auth.gratisgis.org or similar); we hit /admin/realms/<r>/
# under it. The script uses the realm's admin client to get a token
# rather than the master realm so it works against the same client
# that portal-api already authenticates as.
KEYCLOAK_URL="${KEYCLOAK_URL:-https://auth.gratisgis.org}"
REALM="${KEYCLOAK_REALM:-gratis-gis}"
ADMIN_USER="${KEYCLOAK_BOOTSTRAP_ADMIN:-admin}"
ADMIN_PASS="${KEYCLOAK_BOOTSTRAP_PASSWORD:-${KEYCLOAK_ADMIN_PASSWORD:-}}"

if [[ -z "${ADMIN_PASS:-}" ]]; then
  echo "FATAL: need KEYCLOAK_BOOTSTRAP_PASSWORD or KEYCLOAK_ADMIN_PASSWORD in $ENV_FILE." >&2
  echo "       This is the master-realm admin password used to mint admin API tokens." >&2
  exit 1
fi

echo "=== Acquiring admin token from $KEYCLOAK_URL/realms/master ==="
TOKEN="$(curl -fsS -X POST \
  "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password" \
  -d "client_id=admin-cli" \
  -d "username=$ADMIN_USER" \
  -d "password=$ADMIN_PASS" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"

if [[ -z "$TOKEN" ]]; then
  echo "FATAL: failed to obtain admin token." >&2
  exit 1
fi

api() {
  local method="$1"
  local path="$2"
  shift 2
  curl -fsS -X "$method" \
    "$KEYCLOAK_URL/admin/realms/$REALM$path" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    "$@"
}

# Resolve a username to its Keycloak user id, or "" if absent.
user_id() {
  local username="$1"
  api GET "/users?username=$username&exact=true" \
    | python3 -c 'import json,sys; arr=json.load(sys.stdin); print(arr[0]["id"] if arr else "")'
}

upsert_user() {
  local username="$1"
  local first="$2"
  local last="$3"
  local password="$4"
  local org_role="$5"

  echo "--- Upserting $username (role=$org_role) ---"
  local existing
  existing="$(user_id "$username")"

  local body
  body="$(python3 -c "
import json
print(json.dumps({
  'username': '$username',
  'firstName': '$first',
  'lastName': '$last',
  'email': '$username@example.test',
  'emailVerified': True,
  'enabled': True,
  'attributes': {
    'org': ['${PORTAL_ORG_SLUG:-gratis-gis}'],
    'org_role': ['$org_role'],
  },
}))
")"

  if [[ -n "$existing" ]]; then
    echo "  user already exists ($existing); updating profile + role"
    api PUT "/users/$existing" -d "$body" > /dev/null
  else
    echo "  creating new user"
    api POST "/users" -d "$body" > /dev/null
    existing="$(user_id "$username")"
  fi

  # Reset password to the documented value. password_credentials
  # is the same endpoint Keycloak's admin UI uses; temporary=false
  # means the user is NOT forced to change it on next login.
  echo "  setting password"
  local pwd_body
  pwd_body="$(python3 -c "
import json
print(json.dumps({
  'type': 'password',
  'value': '$password',
  'temporary': False,
}))
")"
  api PUT "/users/$existing/reset-password" -d "$pwd_body" > /dev/null

  echo "  done: $username"
}

upsert_user "tester-admin"       "Tester" "Admin"       "Admin123!"       "admin"
upsert_user "tester-contributor" "Tester" "Contributor" "Contributor123!" "contributor"
upsert_user "tester-viewer"      "Tester" "Viewer"      "Viewer123!"      "viewer"

echo ""
echo "=== Done. Three test users provisioned in realm '$REALM'. ==="
echo ""
echo "Next steps:"
echo "  1. Sign in once as each (so auth-sync creates local user rows)."
echo "  2. Recapture the golden state: sudo bash infra/snapshot-golden.sh"
echo "  3. Verify tester-admin is NOT is_protected:"
echo "     docker exec gratis-gis-prod-postgres psql -U gratisgis -d gratisgis \\"
echo "       -c \"SELECT username, org_role, is_protected FROM \\\"user\\\";\""
