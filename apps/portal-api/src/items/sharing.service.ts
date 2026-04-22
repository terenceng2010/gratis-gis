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
