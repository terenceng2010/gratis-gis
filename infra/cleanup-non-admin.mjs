// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pre-snapshot purge: delete every item whose owner is NOT the
// bootstrap admin so a stray tester user's work doesn't get baked
// into the daily golden-state snapshot.
//
// Runs inside the portal-api container during snapshot-golden.sh
// (so it can reach `keycloak` and `localhost:4000` over the compose
// network). Discovers the admin user from the JWT subject claim
// rather than hard-coding a UUID -- the bootstrap admin is whoever
// the script can sign in as, which is the right semantic for "the
// curator whose content makes up the demo."
//
// For each non-admin item: soft-delete then purge via the portal-api
// REST endpoints. That routes through ItemsService.purge ->
// tearDownItemBackingStorage, which drops per-layer feature tables,
// removes MinIO blobs, and tidies observation partitions. SQL-only
// deletion would leave those as orphans, which then end up in the
// MinIO tarball and bloat the snapshot.
//
// Required env:
//   ADMIN_PWD       - the bootstrap admin's Keycloak password
//                     (.env.prod INITIAL_USER_PASSWORD)
// Optional env:
//   ADMIN_USERNAME  - default 'admin'
//   API_URL         - default 'http://localhost:4000'
//   KEYCLOAK_URL    - default 'http://keycloak:8080'
//   REALM           - default 'gratis-gis'
//   CLIENT_ID       - default 'portal-web'
//
// Exit code: 0 on full or partial success (logs are the source of
// truth). 1 only when the admin token can't be obtained -- without
// that we can't tell who NOT to purge, so failing closed protects
// against accidentally wiping everything.

const API = process.env.API_URL ?? 'http://localhost:4000';
const KEYCLOAK = process.env.KEYCLOAK_URL ?? 'http://keycloak:8080';
const REALM = process.env.REALM ?? 'gratis-gis';
const CLIENT_ID = process.env.CLIENT_ID ?? 'portal-web';
const USERNAME = process.env.ADMIN_USERNAME ?? 'admin';

if (!process.env.ADMIN_PWD) {
  console.error('cleanup-non-admin: ADMIN_PWD is required');
  process.exit(1);
}

async function getAdminToken() {
  const r = await fetch(
    `${KEYCLOAK}/realms/${REALM}/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: CLIENT_ID,
        username: USERNAME,
        password: process.env.ADMIN_PWD,
      }),
    },
  );
  if (!r.ok) {
    throw new Error(`keycloak ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const j = await r.json();
  if (!j.access_token) {
    throw new Error(`no access_token: ${JSON.stringify(j).slice(0, 200)}`);
  }
  // Decode the sub claim so we know which user is "the admin"
  // without trusting a CLI argument or hard-coded UUID. The signing
  // step (passport-jwt strategy) is what gates trust on the API
  // side; we just need to know which id to compare ownerIds against.
  const payload = JSON.parse(
    Buffer.from(j.access_token.split('.')[1], 'base64').toString(),
  );
  return { token: j.access_token, adminId: payload.sub };
}

/**
 * Walk the items list and the admin trash list, dedupe by id, and
 * return every item the caller can see. The two endpoints partition
 * by deleted_at (live vs trashed) and don't overlap on a healthy
 * deployment, but dedupe is cheap defense if a future portal-api
 * version changes the contract.
 */
async function listAllItems(token) {
  const headers = { Authorization: `Bearer ${token}` };
  const byId = new Map();
  async function pull(path) {
    const r = await fetch(`${API}${path}`, { headers });
    if (!r.ok) {
      console.error(
        `list ${path} -> ${r.status}: ${(await r.text()).slice(0, 200)}`,
      );
      return;
    }
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.items ?? j.data ?? []);
    for (const it of arr) byId.set(it.id, it);
  }
  await pull('/api/items?pageSize=500');
  // /api/items/trash is the admin trash view; tolerates 404 if a
  // portal-api version doesn't expose it -- the live list alone
  // still catches the loud case (active tester apps).
  await pull('/api/items/trash?pageSize=500');
  return [...byId.values()];
}

async function purgeOne(token, item) {
  const headers = { Authorization: `Bearer ${token}` };
  // Live items must be trashed before they can be purged
  // (ItemsService.purge gates on item.deletedAt). Trashed items
  // skip straight to purge.
  if (!item.deletedAt) {
    const r = await fetch(`${API}/api/items/${item.id}`, {
      method: 'DELETE',
      headers,
    });
    if (!r.ok) {
      console.error(
        `  soft-delete ${item.id} -> ${r.status}: ${(await r.text()).slice(0, 200)}`,
      );
      return false;
    }
  }
  const r = await fetch(`${API}/api/items/${item.id}/purge`, {
    method: 'DELETE',
    headers,
  });
  if (!r.ok) {
    console.error(
      `  purge ${item.id} -> ${r.status}: ${(await r.text()).slice(0, 200)}`,
    );
    return false;
  }
  return true;
}

(async () => {
  const { token, adminId } = await getAdminToken();
  console.log(`cleanup-non-admin: admin = ${adminId}`);

  const items = await listAllItems(token);
  const toPurge = items.filter((i) => i.ownerId !== adminId);
  console.log(
    `cleanup-non-admin: ${items.length} items total, ${toPurge.length} non-admin to purge`,
  );

  let ok = 0;
  let fail = 0;
  for (const it of toPurge) {
    const success = await purgeOne(token, it);
    if (success) {
      console.log(
        `  ok ${it.type}\t${it.title} (${it.id}${it.deletedAt ? ', was trashed' : ''})`,
      );
      ok += 1;
    } else {
      fail += 1;
    }
  }
  console.log(`cleanup-non-admin: done. purged=${ok} failed=${fail}`);
  // Exit 0 even with partial failures. The snapshot proceeds; the
  // failed ids get another chance on the next run, and the operator
  // sees them in the snapshot log.
})().catch((e) => {
  console.error('cleanup-non-admin FATAL:', e instanceof Error ? e.message : e);
  // Exit 1 here only if the admin token couldn't be obtained (thrown
  // above). Anything else is logged + swallowed in purgeOne so the
  // snapshot doesn't get blocked by one bad item.
  process.exit(1);
});
