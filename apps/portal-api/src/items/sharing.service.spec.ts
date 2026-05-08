// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Item, ItemShare } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { SharingService } from './sharing.service.js';

/**
 * Cedar Phase B regression suite for SharingService. Every branch of
 * the pre-migration imperative implementation is encoded here so the
 * Cedar-backed implementation can be verified against the same
 * invariants. PrismaService is undefined in this fixture: the four
 * canX methods don't touch it (they only consume the Prisma-typed
 * Item and ItemShare records the caller passes in).
 */

const FAR_FUTURE = new Date('2099-01-01T00:00:00Z');
const FAR_PAST = new Date('2020-01-01T00:00:00Z');

const ANY_PRISMA = undefined as unknown as ConstructorParameters<
  typeof SharingService
>[0];

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'alice',
    email: 'alice@example.com',
    orgRole: 'contributor',
    groupIds: [],
    capabilities: new Set(),
    ...overrides,
  } as AuthUser;
}

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'item-1',
    orgId: 'org-1',
    ownerId: 'owner-1',
    type: 'data_layer',
    title: 'Parcels',
    description: '',
    tags: [],
    data: {},
    access: 'private',
    bbox: [],
    thumbnailUrl: null,
    license: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastUsageAt: null,
    ...(overrides as Record<string, unknown>),
  } as unknown as Item;
}

function makeShare(overrides: Partial<ItemShare> = {}): ItemShare {
  return {
    itemId: 'item-1',
    principalType: 'user',
    principalId: 'user-1',
    permission: 'view',
    rowScope: 'all',
    expiresAt: null,
    geoLimit: null,
    geoBoundaryId: null,
    createdAt: new Date(),
    ...(overrides as Record<string, unknown>),
  } as unknown as ItemShare;
}

describe('SharingService', () => {
  let svc: SharingService;
  let policy: PolicyService;

  beforeAll(() => {
    policy = new PolicyService();
    svc = new SharingService(ANY_PRISMA, policy);
  });

  // -------------------------------------------------------------
  // Owner branch (rule 1): owner can do anything to their own item.
  // -------------------------------------------------------------
  describe('owner', () => {
    const owner = makeUser({ id: 'alice' });
    const item = makeItem({ ownerId: 'alice', access: 'private' });

    it('canRead', () => {
      expect(svc.canRead(owner, item)).toBe(true);
    });
    it('canEdit', () => {
      expect(svc.canEdit(owner, item)).toBe(true);
    });
    it('canDownload', () => {
      expect(svc.canDownload(owner, item)).toBe(true);
    });
    it('canAdmin', () => {
      expect(svc.canAdmin(owner, item)).toBe(true);
    });
  });

  // -------------------------------------------------------------
  // Org admin branch (rule 2): admin can do anything inside org.
  // -------------------------------------------------------------
  describe('org admin in same org', () => {
    const admin = makeUser({
      id: 'admin-1',
      orgId: 'org-1',
      orgRole: 'admin',
    });
    const item = makeItem({
      ownerId: 'someone-else',
      orgId: 'org-1',
      access: 'private',
    });

    it('canRead', () => {
      expect(svc.canRead(admin, item)).toBe(true);
    });
    it('canEdit', () => {
      expect(svc.canEdit(admin, item)).toBe(true);
    });
    it('canDownload', () => {
      expect(svc.canDownload(admin, item)).toBe(true);
    });
    it('canAdmin', () => {
      expect(svc.canAdmin(admin, item)).toBe(true);
    });
  });

  describe('org admin in different org', () => {
    const admin = makeUser({
      id: 'admin-1',
      orgId: 'org-other',
      orgRole: 'admin',
    });
    const item = makeItem({
      ownerId: 'someone-else',
      orgId: 'org-1',
      access: 'private',
    });

    it('canRead is denied (admin power is org-scoped)', () => {
      expect(svc.canRead(admin, item)).toBe(false);
    });
    it('canEdit is denied', () => {
      expect(svc.canEdit(admin, item)).toBe(false);
    });
    it('canDownload is denied', () => {
      expect(svc.canDownload(admin, item)).toBe(false);
    });
    it('canAdmin is denied', () => {
      expect(svc.canAdmin(admin, item)).toBe(false);
    });
  });

  // -------------------------------------------------------------
  // Public access (rules 3 + 5).
  // -------------------------------------------------------------
  describe('public access', () => {
    const stranger = makeUser({ id: 'stranger', orgId: 'org-other' });
    const item = makeItem({
      ownerId: 'someone-else',
      orgId: 'org-1',
      access: 'public',
    });

    it('canRead is allowed', () => {
      expect(svc.canRead(stranger, item)).toBe(true);
    });
    it('canDownload is allowed', () => {
      expect(svc.canDownload(stranger, item)).toBe(true);
    });
    it('canEdit is denied (public != edit grant)', () => {
      expect(svc.canEdit(stranger, item)).toBe(false);
    });
    it('canAdmin is denied', () => {
      expect(svc.canAdmin(stranger, item)).toBe(false);
    });
  });

  // -------------------------------------------------------------
  // Org access (rules 4 + 6).
  // -------------------------------------------------------------
  describe('org access, same-org member', () => {
    const member = makeUser({ id: 'member-1', orgId: 'org-1' });
    const item = makeItem({
      ownerId: 'someone-else',
      orgId: 'org-1',
      access: 'org',
    });

    it('canRead', () => {
      expect(svc.canRead(member, item)).toBe(true);
    });
    it('canDownload', () => {
      expect(svc.canDownload(member, item)).toBe(true);
    });
    it('canEdit denied (org access != edit grant)', () => {
      expect(svc.canEdit(member, item)).toBe(false);
    });
    it('canAdmin denied', () => {
      expect(svc.canAdmin(member, item)).toBe(false);
    });
  });

  describe('org access, different-org member', () => {
    const stranger = makeUser({ id: 'stranger', orgId: 'org-other' });
    const item = makeItem({
      ownerId: 'someone-else',
      orgId: 'org-1',
      access: 'org',
    });

    it('canRead denied', () => {
      expect(svc.canRead(stranger, item)).toBe(false);
    });
    it('canDownload denied', () => {
      expect(svc.canDownload(stranger, item)).toBe(false);
    });
    it('canEdit denied', () => {
      expect(svc.canEdit(stranger, item)).toBe(false);
    });
    it('canAdmin denied', () => {
      expect(svc.canAdmin(stranger, item)).toBe(false);
    });
  });

  // -------------------------------------------------------------
  // Explicit shares (rules 7 + 8 + 9).
  // -------------------------------------------------------------
  describe('explicit user share at view tier', () => {
    const u = makeUser({ id: 'user-1' });
    const item = makeItem({ ownerId: 'someone-else', access: 'private' });
    const share = makeShare({
      principalType: 'user',
      principalId: 'user-1',
      permission: 'view',
    });

    it('canRead', () => {
      expect(svc.canRead(u, item, [share])).toBe(true);
    });
    it('canDownload denied (view tier insufficient)', () => {
      expect(svc.canDownload(u, item, [share])).toBe(false);
    });
    it('canEdit denied', () => {
      expect(svc.canEdit(u, item, [share])).toBe(false);
    });
    it('canAdmin denied (no admin path through shares)', () => {
      expect(svc.canAdmin(u, item)).toBe(false);
    });
  });

  describe('explicit user share at download tier', () => {
    const u = makeUser({ id: 'user-1' });
    const item = makeItem({ ownerId: 'someone-else', access: 'private' });
    const share = makeShare({ permission: 'download' });

    it('canRead', () => {
      expect(svc.canRead(u, item, [share])).toBe(true);
    });
    it('canDownload', () => {
      expect(svc.canDownload(u, item, [share])).toBe(true);
    });
    it('canEdit denied', () => {
      expect(svc.canEdit(u, item, [share])).toBe(false);
    });
    it('canAdmin denied', () => {
      expect(svc.canAdmin(u, item)).toBe(false);
    });
  });

  describe('explicit user share at edit tier', () => {
    const u = makeUser({ id: 'user-1' });
    const item = makeItem({ ownerId: 'someone-else', access: 'private' });
    const share = makeShare({ permission: 'edit' });

    it('canRead', () => {
      expect(svc.canRead(u, item, [share])).toBe(true);
    });
    it('canDownload', () => {
      expect(svc.canDownload(u, item, [share])).toBe(true);
    });
    it('canEdit', () => {
      expect(svc.canEdit(u, item, [share])).toBe(true);
    });
    it('canAdmin denied', () => {
      expect(svc.canAdmin(u, item)).toBe(false);
    });
  });

  describe('explicit user share at admin tier', () => {
    const u = makeUser({ id: 'user-1' });
    const item = makeItem({ ownerId: 'someone-else', access: 'private' });
    const share = makeShare({ permission: 'admin' });

    it('canRead', () => {
      expect(svc.canRead(u, item, [share])).toBe(true);
    });
    it('canDownload', () => {
      expect(svc.canDownload(u, item, [share])).toBe(true);
    });
    it('canEdit (admin tier promotes to edit)', () => {
      expect(svc.canEdit(u, item, [share])).toBe(true);
    });
    it('canAdmin denied (admin share != ownership)', () => {
      expect(svc.canAdmin(u, item)).toBe(false);
    });
  });

  describe('group share, user is a member', () => {
    const u = makeUser({ id: 'u-1', groupIds: ['g-1'] });
    const item = makeItem({ ownerId: 'someone-else', access: 'private' });
    const share = makeShare({
      principalType: 'group',
      principalId: 'g-1',
      permission: 'edit',
    });

    it('canEdit', () => {
      expect(svc.canEdit(u, item, [share])).toBe(true);
    });
  });

  describe('group share, user is NOT a member', () => {
    const u = makeUser({ id: 'u-1', groupIds: ['g-other'] });
    const item = makeItem({ ownerId: 'someone-else', access: 'private' });
    const share = makeShare({
      principalType: 'group',
      principalId: 'g-1',
      permission: 'edit',
    });

    it('canEdit denied', () => {
      expect(svc.canEdit(u, item, [share])).toBe(false);
    });
  });

  describe('expired share', () => {
    const u = makeUser({ id: 'user-1' });
    const item = makeItem({ ownerId: 'someone-else', access: 'private' });
    const share = makeShare({
      permission: 'edit',
      expiresAt: FAR_PAST,
    });

    it('canRead denied', () => {
      expect(svc.canRead(u, item, [share])).toBe(false);
    });
    it('canEdit denied', () => {
      expect(svc.canEdit(u, item, [share])).toBe(false);
    });
  });

  describe('un-expired share with future expiresAt', () => {
    const u = makeUser({ id: 'user-1' });
    const item = makeItem({ ownerId: 'someone-else', access: 'private' });
    const share = makeShare({
      permission: 'edit',
      expiresAt: FAR_FUTURE,
    });

    it('canEdit allowed', () => {
      expect(svc.canEdit(u, item, [share])).toBe(true);
    });
  });

  // -------------------------------------------------------------
  // Edge: a user with multiple matching shares takes the highest
  // tier across them. This is the "best of all matches" rule the
  // imperative version implemented via or-of-matches.
  // -------------------------------------------------------------
  describe('multiple matching shares pick the best tier', () => {
    const u = makeUser({ id: 'u-1', groupIds: ['g-1'] });
    const item = makeItem({ ownerId: 'someone-else', access: 'private' });
    const lowShare = makeShare({
      principalType: 'user',
      principalId: 'u-1',
      permission: 'view',
    });
    const highShare = makeShare({
      principalType: 'group',
      principalId: 'g-1',
      permission: 'edit',
    });

    it('canEdit allowed via the higher-tier group share', () => {
      expect(svc.canEdit(u, item, [lowShare, highShare])).toBe(true);
    });
  });

  // -------------------------------------------------------------
  // Stranger with no path: every check denies.
  // -------------------------------------------------------------
  describe('stranger with no path to a private item', () => {
    const stranger = makeUser({ id: 'stranger', orgId: 'org-other' });
    const item = makeItem({
      ownerId: 'someone-else',
      orgId: 'org-1',
      access: 'private',
    });

    it.each(['canRead', 'canEdit', 'canDownload', 'canAdmin'] as const)(
      '%s denied',
      (m) => {
        if (m === 'canAdmin') {
          expect(svc[m](stranger, item)).toBe(false);
        } else {
          expect(svc[m](stranger, item, [])).toBe(false);
        }
      },
    );
  });
});
