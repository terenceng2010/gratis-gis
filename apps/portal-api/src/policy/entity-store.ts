// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Item, ItemShare } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import type { PolicyEntity, PolicyEntityRef } from './policy.service.js';

/**
 * Build the request-scoped Cedar entity store the default policies
 * need. Pre-resolves group memberships and per-share matches so the
 * Cedar policy text doesn't need set-builder gymnastics; the
 * resulting attribute layout is:
 *
 *   User::"<userId>"
 *     org   : Org::"<orgId>"
 *     role  : "admin" | "contributor" | "viewer"
 *
 *   Org::"<orgId>"   (no attributes; identity-only entity)
 *
 *   Item::"<itemId>"
 *     owner          : User::"<ownerId>"
 *     org            : Org::"<orgId>"
 *     access         : "private" | "org" | "public"
 *     viewers        : Set<User>  -- principals with at least a
 *                                   view-tier matching share, or [].
 *                                   In practice this is either [] or
 *                                   [the calling user] -- we only
 *                                   need to encode "this user has a
 *                                   matching share" for the request,
 *                                   not the full viewer roster.
 *     downloaders    : Set<User>  -- same pattern, download-tier
 *     editors        : Set<User>  -- same pattern, edit-tier
 *
 * The viewers / downloaders / editors sets only ever contain the
 * calling user (or no one). That keeps the entity store O(1) per
 * check rather than O(N shares) and avoids leaking other users'
 * share grants into the in-memory store. The downside is that the
 * same entity store can't answer "does someone else have access
 * here?" -- but that's not a question the runtime check needs to
 * answer; it's a separate admin / audit concern.
 */
export function buildEntityStore(args: {
  user: AuthUser;
  item: Item;
  shares: readonly ItemShare[];
}): PolicyEntity[] {
  const { user, item, shares } = args;

  // Pre-resolve which share tiers the calling user matches.
  const tier = matchedShareTier(user, shares);

  const userRef: PolicyEntityRef = { type: 'User', id: user.id };
  const ownerRef: PolicyEntityRef = { type: 'User', id: item.ownerId };
  const userOrgRef: PolicyEntityRef = { type: 'Org', id: user.orgId };
  const itemOrgRef: PolicyEntityRef = { type: 'Org', id: item.orgId };

  const entities: PolicyEntity[] = [
    {
      uid: userRef,
      attrs: {
        org: cedarEntityValue(userOrgRef),
        role: user.orgRole,
      },
      parents: [userOrgRef],
    },
    {
      uid: { type: 'Org', id: user.orgId },
      attrs: {},
      parents: [],
    },
  ];

  // Owner entity, if it isn't the calling user.
  if (item.ownerId !== user.id) {
    entities.push({
      uid: ownerRef,
      attrs: { org: cedarEntityValue(itemOrgRef) },
      parents: [itemOrgRef],
    });
  }

  // Item's org entity, if distinct from the calling user's.
  if (item.orgId !== user.orgId) {
    entities.push({
      uid: { type: 'Org', id: item.orgId },
      attrs: {},
      parents: [],
    });
  }

  // Build the shareGrant sets. Cedar's CedarValueJson Set encoding
  // is a plain JSON array of refs; one calling-user ref per matched
  // tier, [] otherwise. The default policy's `.contains(principal)`
  // check then succeeds iff the user has at least the matching
  // tier. Tier ordering: edit > download > view, so an explicit
  // edit share also satisfies download / view checks.
  const viewers = tier !== 'none' ? [cedarEntityValue(userRef)] : [];
  const downloaders =
    tier === 'download' || tier === 'edit'
      ? [cedarEntityValue(userRef)]
      : [];
  const editors = tier === 'edit' ? [cedarEntityValue(userRef)] : [];

  entities.push({
    uid: { type: 'Item', id: item.id },
    attrs: {
      owner: cedarEntityValue(ownerRef),
      org: cedarEntityValue(itemOrgRef),
      access: item.access,
      viewers,
      downloaders,
      editors,
    },
    parents: [itemOrgRef],
  });

  return entities;
}

/**
 * Cedar's WASM binding wants entity references in attributes wrapped
 * as `{ __entity: { type, id } }`. Plain `{ type, id }` works for
 * top-level principal/action/resource but not as nested values; the
 * wrapper is the difference.
 */
function cedarEntityValue(ref: PolicyEntityRef): { __entity: PolicyEntityRef } {
  return { __entity: ref };
}

type ShareTier = 'none' | 'view' | 'download' | 'edit';

/**
 * Highest tier of share this user matches against the given share
 * list. A non-expired share whose principal matches the user (or one
 * of their groups) contributes its permission level. We collapse
 * permission strings into the three tier we care about ('view',
 * 'download', 'edit'); 'admin' rolls up to 'edit' since the
 * caller-side policy doesn't currently grant `Action::"admin"` from
 * any share (see SharingService.canAdmin).
 */
function matchedShareTier(
  user: AuthUser,
  shares: readonly ItemShare[],
): ShareTier {
  let best: ShareTier = 'none';
  for (const s of shares) {
    if (!shareMatches(user, s)) continue;
    if (isShareExpired(s)) continue;
    const tier = tierFromPermission(s.permission);
    if (tierRank(tier) > tierRank(best)) best = tier;
  }
  return best;
}

function shareMatches(user: AuthUser, share: ItemShare): boolean {
  if (share.principalType === 'user') return share.principalId === user.id;
  if (share.principalType === 'group') {
    return user.groupIds.includes(share.principalId);
  }
  return false;
}

function isShareExpired(share: ItemShare): boolean {
  const expiresAt = (share as ItemShare & { expiresAt?: Date | string | null })
    .expiresAt;
  if (!expiresAt) return false;
  const t = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return t.getTime() <= Date.now();
}

function tierFromPermission(permission: string): ShareTier {
  // Schema allows 'view' / 'download' / 'edit' / 'admin'. The 'admin'
  // share permission opens edit + download + view (it's the "highest
  // explicit grant" tier); the canAdmin gate is owner-/org-admin-
  // only and doesn't consult the share tier at all.
  if (permission === 'edit' || permission === 'admin') return 'edit';
  if (permission === 'download') return 'download';
  if (permission === 'view') return 'view';
  return 'none';
}

function tierRank(tier: ShareTier): number {
  switch (tier) {
    case 'edit':
      return 3;
    case 'download':
      return 2;
    case 'view':
      return 1;
    case 'none':
    default:
      return 0;
  }
}
