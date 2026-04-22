import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ItemAccess, ItemType, PrincipalType, Prisma, SharePermission } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { SharingService } from './sharing.service.js';

// Optional fields use `| undefined` explicitly so class-validator DTOs
// (which leave unset keys present-as-undefined) can satisfy these types
// under `exactOptionalPropertyTypes: true`.
export interface CreateItemInput {
  type: ItemType;
  title: string;
  description?: string | undefined;
  tags?: string[] | undefined;
  data: Prisma.InputJsonValue;
  access?: ItemAccess | undefined;
  /** Pass null or omit to start without a custom thumbnail. */
  thumbnailUrl?: string | null | undefined;
}

export interface UpdateItemInput {
  title?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  data?: Prisma.InputJsonValue | undefined;
  access?: ItemAccess | undefined;
  /** Pass null to clear. */
  thumbnailUrl?: string | null | undefined;
}

export interface ShareItemInput {
  principalType: PrincipalType;
  principalId: string;
  permission?: SharePermission | undefined;
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sharing: SharingService,
  ) {}

  list(user: AuthUser, opts: { mine?: boolean; type?: ItemType; q?: string } = {}) {
    const where: Prisma.ItemWhereInput = opts.mine
      ? { ownerId: user.id, deletedAt: null }
      : this.sharing.visibleWhere(user);
    if (opts.type) where.type = opts.type;
    if (opts.q) {
      where.OR = [
        { title: { contains: opts.q, mode: 'insensitive' } },
        { description: { contains: opts.q, mode: 'insensitive' } },
        { tags: { has: opts.q } },
      ];
    }
    return this.prisma.item.findMany({ where, orderBy: { updatedAt: 'desc' } });
  }

  /**
   * List the caller's trash. We deliberately scope this to items the
   * caller actually owns (plus org-admin) rather than anything they
   * could see-and-edit while it was live, so a collaborator can't
   * surface or restore someone else's deleted content. Owner-only
   * matches what users expect from a "my recycle bin" metaphor.
   */
  listTrash(user: AuthUser) {
    const where: Prisma.ItemWhereInput =
      user.orgRole === 'admin'
        ? { orgId: user.orgId, deletedAt: { not: null } }
        : { ownerId: user.id, deletedAt: { not: null } };
    return this.prisma.item.findMany({ where, orderBy: { deletedAt: 'desc' } });
  }

  async get(user: AuthUser, id: string, opts: { includeTrashed?: boolean } = {}) {
    const item = await this.prisma.item.findUnique({
      where: { id },
      include: { shares: true },
    });
    if (!item) throw new NotFoundException('Item not found');
    // Trashed items are invisible to anyone except the owner and org admins,
    // and only when they explicitly ask for trashed items. This keeps a
    // soft-deleted item out of the normal read path entirely.
    if (item.deletedAt) {
      if (!opts.includeTrashed) throw new NotFoundException('Item not found');
      if (!this.sharing.canAdmin(user, item)) {
        throw new NotFoundException('Item not found');
      }
      return item;
    }
    if (!this.sharing.canRead(user, item, item.shares)) {
      // Don't leak existence; return 404 instead of 403 for unauthenticated reads
      throw new NotFoundException('Item not found');
    }
    return item;
  }

  create(user: AuthUser, input: CreateItemInput) {
    return this.prisma.item.create({
      data: {
        orgId: user.orgId,
        ownerId: user.id,
        type: input.type,
        title: input.title,
        description: input.description ?? '',
        tags: input.tags ?? [],
        data: input.data,
        access: input.access ?? 'private',
        ...(input.thumbnailUrl ? { thumbnailUrl: input.thumbnailUrl } : {}),
      },
    });
  }

  async update(user: AuthUser, id: string, input: UpdateItemInput) {
    const item = await this.get(user, id);
    const shares = await this.prisma.itemShare.findMany({ where: { itemId: id } });
    if (!this.sharing.canEdit(user, item, shares)) {
      throw new ForbiddenException('You do not have edit permission on this item');
    }
    return this.prisma.item.update({
      where: { id },
      data: {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.tags !== undefined && { tags: input.tags }),
        ...(input.data !== undefined && { data: input.data }),
        ...(input.access !== undefined && { access: input.access }),
        ...(input.thumbnailUrl !== undefined && { thumbnailUrl: input.thumbnailUrl }),
      },
    });
  }

  /**
   * Soft-delete: mark the item as trashed. The row (and its shares) stays
   * in the database so it can be restored. A scheduled job purges rows
   * whose deletedAt is older than the retention window (see
   * docs/soft-delete.md).
   */
  async remove(user: AuthUser, id: string) {
    const item = await this.get(user, id);
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException('Only the owner or an org admin can delete an item');
    }
    await this.prisma.item.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /** Restore a trashed item. Only the owner or an org admin can restore. */
  async restore(user: AuthUser, id: string) {
    const item = await this.get(user, id, { includeTrashed: true });
    if (!item.deletedAt) {
      // Not in the trash -- nothing to do, and returning 200 would
      // hide a client bug. 400 is more informative than silently no-op.
      throw new BadRequestException('Item is not in the trash');
    }
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException('Only the owner or an org admin can restore an item');
    }
    return this.prisma.item.update({
      where: { id },
      data: { deletedAt: null },
    });
  }

  /**
   * Permanently delete a trashed item. Cascades to item_share rows and,
   * once feature-services ship, to the tenant feature table. Only
   * available for items already in the trash so there is always a
   * two-step ceremony between "delete" and "gone".
   */
  async purge(user: AuthUser, id: string) {
    const item = await this.get(user, id, { includeTrashed: true });
    if (!item.deletedAt) {
      throw new BadRequestException('Item must be in the trash before it can be purged');
    }
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException('Only the owner or an org admin can purge an item');
    }
    await this.prisma.item.delete({ where: { id } });
  }

  async share(user: AuthUser, id: string, input: ShareItemInput) {
    const item = await this.get(user, id);
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException('Only the owner or an org admin can change sharing');
    }
    await this.assertPrincipalExists(input.principalType, input.principalId);
    return this.prisma.itemShare.upsert({
      where: {
        itemId_principalType_principalId: {
          itemId: id,
          principalType: input.principalType,
          principalId: input.principalId,
        },
      },
      update: { permission: input.permission ?? 'view' },
      create: {
        itemId: id,
        principalType: input.principalType,
        principalId: input.principalId,
        permission: input.permission ?? 'view',
      },
    });
  }

  async unshare(user: AuthUser, id: string, input: ShareItemInput) {
    const item = await this.get(user, id);
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException('Only the owner or an org admin can change sharing');
    }
    await this.prisma.itemShare.delete({
      where: {
        itemId_principalType_principalId: {
          itemId: id,
          principalType: input.principalType,
          principalId: input.principalId,
        },
      },
    });
  }

  private async assertPrincipalExists(type: PrincipalType, id: string) {
    if (type === 'user') {
      const hit = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
      if (!hit) throw new BadRequestException('Unknown user principal');
    } else if (type === 'group') {
      // A trashed group should not be a valid share target; treat it as
      // unknown so clients can't create new references to something that
      // will disappear on purge.
      const hit = await this.prisma.group.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!hit) throw new BadRequestException('Unknown group principal');
    }
  }
}
