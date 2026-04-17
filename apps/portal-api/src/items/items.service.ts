import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ItemAccess, ItemType, PrincipalType, Prisma, SharePermission } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { SharingService } from './sharing.service.js';

export interface CreateItemInput {
  type: ItemType;
  title: string;
  description?: string;
  tags?: string[];
  data: Prisma.InputJsonValue;
  access?: ItemAccess;
}

export interface UpdateItemInput {
  title?: string;
  description?: string;
  tags?: string[];
  data?: Prisma.InputJsonValue;
  access?: ItemAccess;
}

export interface ShareItemInput {
  principalType: PrincipalType;
  principalId: string;
  permission?: SharePermission;
}

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sharing: SharingService,
  ) {}

  list(user: AuthUser, opts: { mine?: boolean; type?: ItemType; q?: string } = {}) {
    const where: Prisma.ItemWhereInput = opts.mine
      ? { ownerId: user.id }
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

  async get(user: AuthUser, id: string) {
    const item = await this.prisma.item.findUnique({
      where: { id },
      include: { shares: true },
    });
    if (!item) throw new NotFoundException('Item not found');
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
        dataJson: input.data,
        access: input.access ?? 'private',
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
        ...(input.data !== undefined && { dataJson: input.data }),
        ...(input.access !== undefined && { access: input.access }),
      },
    });
  }

  async remove(user: AuthUser, id: string) {
    const item = await this.get(user, id);
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException('Only the owner or an org admin can delete an item');
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
      const hit = await this.prisma.group.findUnique({ where: { id }, select: { id: true } });
      if (!hit) throw new BadRequestException('Unknown group principal');
    }
  }
}
