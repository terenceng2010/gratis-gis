// SPDX-License-Identifier: AGPL-3.0-or-later
import { PolicyService } from './policy.service.js';

/**
 * Helper: build the entity attributes the default policy expects.
 * Cedar does NOT allow attribute access on the principal/resource
 * UID (`principal.id`); cross-entity references must go through
 * entity-typed attributes. The portal's eventual EntityStore will
 * write items with `owner` and `org` as entity refs (`User::"..."`,
 * `Org::"..."`); these helpers do the same so the spec exercises
 * the production policy text verbatim.
 */
function userEntity(args: {
  id: string;
  orgId: string;
  role: 'admin' | 'contributor' | 'viewer';
}) {
  return {
    uid: { type: 'User', id: args.id },
    attrs: {
      org: { __entity: { type: 'Org', id: args.orgId } },
      role: args.role,
    },
    parents: [{ type: 'Org', id: args.orgId }],
  };
}

function itemEntity(args: {
  id: string;
  ownerId: string;
  orgId: string;
  access: 'private' | 'org' | 'public';
}) {
  return {
    uid: { type: 'Item', id: args.id },
    attrs: {
      owner: { __entity: { type: 'User', id: args.ownerId } },
      org: { __entity: { type: 'Org', id: args.orgId } },
      access: args.access,
    },
    parents: [{ type: 'Org', id: args.orgId }],
  };
}

function orgEntity(id: string) {
  return { uid: { type: 'Org', id }, attrs: {}, parents: [] };
}

describe('PolicyService', () => {
  let svc: PolicyService;

  beforeAll(() => {
    svc = new PolicyService();
  });

  it('allows the resource owner to perform any action', () => {
    const result = svc.check({
      principal: { type: 'User', id: 'alice' },
      action: { type: 'Action', id: 'edit' },
      resource: { type: 'Item', id: 'item-1' },
      entities: [
        orgEntity('org-1'),
        userEntity({ id: 'alice', orgId: 'org-1', role: 'contributor' }),
        itemEntity({
          id: 'item-1',
          ownerId: 'alice',
          orgId: 'org-1',
          access: 'private',
        }),
      ],
    });
    expect(result.decision).toBe('allow');
  });

  it('allows an org admin to act on items in their org', () => {
    const result = svc.check({
      principal: { type: 'User', id: 'admin-1' },
      action: { type: 'Action', id: 'edit' },
      resource: { type: 'Item', id: 'item-1' },
      entities: [
        orgEntity('org-1'),
        userEntity({ id: 'admin-1', orgId: 'org-1', role: 'admin' }),
        itemEntity({
          id: 'item-1',
          ownerId: 'someone-else',
          orgId: 'org-1',
          access: 'private',
        }),
      ],
    });
    expect(result.decision).toBe('allow');
  });

  it('denies a non-owner / non-admin against a private item', () => {
    const result = svc.check({
      principal: { type: 'User', id: 'bob' },
      action: { type: 'Action', id: 'edit' },
      resource: { type: 'Item', id: 'item-1' },
      entities: [
        orgEntity('org-1'),
        userEntity({ id: 'bob', orgId: 'org-1', role: 'contributor' }),
        itemEntity({
          id: 'item-1',
          ownerId: 'alice',
          orgId: 'org-1',
          access: 'private',
        }),
      ],
    });
    expect(result.decision).toBe('deny');
  });

  it('allows anyone to read a public item', () => {
    const result = svc.check({
      principal: { type: 'User', id: 'anon-1' },
      action: { type: 'Action', id: 'read' },
      resource: { type: 'Item', id: 'item-1' },
      entities: [
        orgEntity('org-1'),
        orgEntity('org-other'),
        userEntity({ id: 'anon-1', orgId: 'org-1', role: 'viewer' }),
        itemEntity({
          id: 'item-1',
          ownerId: 'someone-else',
          orgId: 'org-other',
          access: 'public',
        }),
      ],
    });
    expect(result.decision).toBe('allow');
  });

  it('denies a different-org member against an org-access item', () => {
    const result = svc.check({
      principal: { type: 'User', id: 'bob' },
      action: { type: 'Action', id: 'read' },
      resource: { type: 'Item', id: 'item-1' },
      entities: [
        orgEntity('org-1'),
        orgEntity('org-2'),
        userEntity({ id: 'bob', orgId: 'org-2', role: 'contributor' }),
        itemEntity({
          id: 'item-1',
          ownerId: 'alice',
          orgId: 'org-1',
          access: 'org',
        }),
      ],
    });
    expect(result.decision).toBe('deny');
  });

  it('allows a same-org member to read an org-access item', () => {
    const result = svc.check({
      principal: { type: 'User', id: 'bob' },
      action: { type: 'Action', id: 'read' },
      resource: { type: 'Item', id: 'item-1' },
      entities: [
        orgEntity('org-1'),
        userEntity({ id: 'bob', orgId: 'org-1', role: 'contributor' }),
        itemEntity({
          id: 'item-1',
          ownerId: 'alice',
          orgId: 'org-1',
          access: 'org',
        }),
      ],
    });
    expect(result.decision).toBe('allow');
  });

  it('honours a caller-supplied policy override', () => {
    // Override forbids edit for everyone; should beat the
    // baseline owner-permit (Cedar's forbid-trumps-permit
    // semantics). This is the shape lens-level custom policies
    // will use to subtract privilege from the platform default.
    const result = svc.check({
      principal: { type: 'User', id: 'alice' },
      action: { type: 'Action', id: 'edit' },
      resource: { type: 'Item', id: 'item-1' },
      policiesText: `
        permit (principal, action, resource) when {
          resource has owner && principal == resource.owner
        };
        forbid (principal, action == Action::"edit", resource);
      `,
      entities: [
        {
          uid: { type: 'Item', id: 'item-1' },
          attrs: {
            owner: { __entity: { type: 'User', id: 'alice' } },
          },
          parents: [],
        },
      ],
    });
    expect(result.decision).toBe('deny');
  });
});
