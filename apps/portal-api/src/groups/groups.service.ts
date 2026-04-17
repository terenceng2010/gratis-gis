import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { GroupAccess, GroupRole } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

export interface CreateGroupInput {
  title: string;
  description?: string;
  access?: GroupAccess;
}

@Injectable()
export class GroupsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Groups visible to the caller: their own + org-visible + public. */
  listVisible(user: AuthUser) {
    return this.prisma.group.findMany({
      where: {
        OR: [
          { members: { some: { userId: user.id } } },
          { orgId: user.orgId, access: { in: ['org', 'public'] } },
          { access: 'public' },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(user: AuthUser, input: CreateGroupInput) {
    return this.prisma.group.create({
      data: {
        orgId: user.orgId,
        ownerId: user.id,
        title: input.title,
        description: input.description ?? '',
        access: input.access ?? 'private',
        members: {
          create: { userId: user.id, role: 'admin' },
        },
      },
    });
  }

  async addMember(user: AuthUser, groupId: string, memberId: string, role: GroupRole = 'member') {
    await this.assertAdminOfGroup(user, groupId);
    return this.prisma.groupMember.upsert({
      where: { groupId_userId: { groupId, userId: memberId } },
      update: { role },
      create: { groupId, userId: memberId, role },
    });
  }

  async removeMember(user: AuthUser, groupId: string, memberId: string) {
    await this.assertAdminOfGroup(user, groupId);
    await this.prisma.groupMember.delete({
      where: { groupId_userId: { groupId, userId: memberId } },
    });
  }

  private async assertAdminOfGroup(user: AuthUser, groupId: string) {
    if (user.orgRole === 'admin') return;
    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: user.id } },
    });
    if (!membership) throw new NotFoundException('Group not found or you are not a member');
    if (membership.role !== 'admin') {
      throw new ForbiddenException('Group admin permission required');
    }
  }
}
