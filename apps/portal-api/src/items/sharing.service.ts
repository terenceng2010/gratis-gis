import { Injectable } from '@nestjs/common';
import type { Item, ItemShare, Prisma } from '@prisma/client';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Single source of truth for item access decisions. Mirrors the algorithm
 * in /docs/data-model.md. Everything that reads or writes items must go
 * through one of these methods.
 */
@Injectable()
export class SharingService {
  constructor(private readonly prisma: PrismaService) {}

  canRead(user: AuthUser, item: Item, shares: ItemShare[] = []): boolean {
    if (item.ownerId === user.id) return true;
    // Org admins see everything in their org — including private items
    // owned by other users. Mirrors the admin behaviour in canEdit /
    // canAdmin so the read path isn't strictly narrower than the
    // write path (which would be surprising).
    if (user.orgRole === 'admin' && item.orgId === user.orgId) return true;
    if (item.access === 'public') return true;
    if (item.access === 'org' && item.orgId === user.orgId) return true;
    return shares.some((s) => this.shareMatches(user, s));
  }

  canEdit(user: AuthUser, item: Item, shares: ItemShare[] = []): boolean {
    if (item.ownerId === user.id) return true;
    if (user.orgRole === 'admin' && item.orgId === user.orgId) return true;
    return shares.some(
      (s) =>
        (s.permission === 'edit' || s.permission === 'admin') && this.shareMatches(user, s),
    );
  }

  canAdmin(user: AuthUser, item: Item): boolean {
    if (item.ownerId === user.id) return true;
    return user.orgRole === 'admin' && item.orgId === user.orgId;
  }

  /**
   * Resolve the geographic restriction that applies to `user` on
   * `item`. Returns a GeoJSON geometry (Polygon or MultiPolygon) when
   * the user is limited to a sub-region, or `null` when they have
   * unrestricted access.
   *
   * Semantics (matches the product-level design in docs/data-model.md):
   *   - Owners, admins, and anyone reading via `access: public` or
   *     `access: org` bypass geo limits entirely — those access paths
   *     are not share rows, so there's nothing to attach a polygon to.
   *   - When reading via an explicit `ItemShare`, the user's effective
   *     access is the UNION of every matching share's geo polygon. If
   *     any matching share has no polygon, the user has full access
   *     (the unrestricted share wins).
   *
   * Callers compose the result into SQL via `ST_GeomFromGeoJSON` +
   * `ST_Intersects`. The result is GeoJSON in EPSG:4326 so no
   * coordinate transform is needed before matching against feature
   * tables (which also use 4326).
   */
  geoLimitFor(
    user: AuthUser,
    item: Item,
    shares: ItemShare[] = [],
  ): unknown | null {
    if (item.ownerId === user.id) return null;
    if (user.orgRole === 'admin' && item.orgId === user.orgId) return null;
    if (item.access === 'public') return null;
    if (item.access === 'org' && item.orgId === user.orgId) return null;

    const matching = shares.filter((s) => this.shareMatches(user, s));
    if (matching.length === 0) return null; // no access at all — caller already handled

    // An unrestricted matching share dominates — the user has full
    // access via that path regardless of any other limited shares.
    const hasUnrestricted = matching.some(
      (s) => !(s as ItemShare & { geoLimit?: unknown }).geoLimit,
    );
    if (hasUnrestricted) return null;

    // Everyone matching is limited. Union their polygons into a
    // single GeometryCollection; PostGIS handles the union at query
    // time so we don't have to bring in a JS geometry lib here.
    const polygons = matching
      .map((s) => (s as ItemShare & { geoLimit?: unknown }).geoLimit)
      .filter((g): g is object => typeof g === 'object' && g !== null);
    if (polygons.length === 0) return null;
    if (polygons.length === 1) return polygons[0];
    return {
      type: 'GeometryCollection',
      geometries: polygons,
    };
  }

  private shareMatches(user: AuthUser, share: ItemShare): boolean {
    if (share.principalType === 'user') return share.principalId === user.id;
    if (share.principalType === 'group') return user.groupIds.includes(share.principalId);
    return false;
  }

  /**
   * Build a Prisma `where` clause selecting only items the user can see.
   * Used for list queries so we don't fetch + filter in memory.
   *
   * Trashed items (deletedAt != null) are excluded by default. Use
   * `includeTrashed` for the trash view specifically; the caller is
   * responsible for adding an explicit `deletedAt: { not: null }` filter
   * when it wants only the trash.
   */
  visibleWhere(
    user: AuthUser,
    opts: { includeTrashed?: boolean } = {},
  ): Prisma.ItemWhereInput {
    // Admin short-circuit: an org admin's "visible" set is every item
    // in their org, regardless of sharing. Matches the point-check in
    // canRead so list queries and per-item checks agree.
    if (user.orgRole === 'admin') {
      const adminAccess: Prisma.ItemWhereInput = { orgId: user.orgId };
      if (opts.includeTrashed) return adminAccess;
      return { AND: [adminAccess, { deletedAt: null }] };
    }

    const principalConditions: Prisma.ItemShareWhereInput[] = [
      { principalType: 'user', principalId: user.id },
    ];
    if (user.groupIds.length > 0) {
      principalConditions.push({
        principalType: 'group',
        principalId: { in: user.groupIds },
      });
    }
    const access: Prisma.ItemWhereInput = {
      OR: [
        { ownerId: user.id },
        { access: 'public' },
        { access: 'org', orgId: user.orgId },
        { shares: { some: { OR: principalConditions } } },
      ],
    };
    if (opts.includeTrashed) return access;
    return { AND: [access, { deletedAt: null }] };
  }
}
