import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type BasemapSourceKind } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

export interface CreateBasemapInput {
  label: string;
  description?: string;
  url: string;
  sourceKind: BasemapSourceKind;
  attribution?: string;
  thumbnailUrl?: string | null;
  config?: Prisma.InputJsonValue;
  isDefault?: boolean;
}

export interface UpdateBasemapInput {
  label?: string;
  description?: string;
  url?: string;
  sourceKind?: BasemapSourceKind;
  attribution?: string;
  thumbnailUrl?: string | null;
  config?: Prisma.InputJsonValue | null;
  isDefault?: boolean;
}

/**
 * Basemaps live per-organization. Any authenticated user in an org
 * can *read* the list (they're used in every web map they open);
 * only org admins can mutate. The "exactly one default per org"
 * invariant is enforced both by a partial unique index (defensive)
 * and by the service flipping any previous default to false when a
 * new one is set.
 */
@Injectable()
export class BasemapsService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthUser) {
    return this.prisma.basemap.findMany({
      where: { orgId: user.orgId },
      orderBy: [{ isDefault: 'desc' }, { label: 'asc' }],
    });
  }

  async get(user: AuthUser, id: string) {
    const row = await this.prisma.basemap.findUnique({ where: { id } });
    if (!row || row.orgId !== user.orgId) {
      throw new NotFoundException('Basemap not found');
    }
    return row;
  }

  async create(user: AuthUser, input: CreateBasemapInput) {
    this.assertAdmin(user);
    const label = input.label.trim();
    const url = input.url.trim();
    if (!label) throw new BadRequestException('label is required');
    if (!url) throw new BadRequestException('url is required');

    // A transaction keeps the "exactly one default" invariant
    // atomic: if the caller flags this as default, flip any prior
    // default to false in the same write so we never observe a
    // transient state with two defaults.
    return this.prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.basemap.updateMany({
          where: { orgId: user.orgId, isDefault: true },
          data: { isDefault: false },
        });
      }
      // Build the create payload explicitly so optional fields that
      // the caller omitted don't become explicit-undefined (which
      // exactOptionalPropertyTypes would reject at compile time).
      const data: Prisma.BasemapCreateInput = {
        org: { connect: { id: user.orgId } },
        label,
        description: input.description ?? '',
        url,
        sourceKind: input.sourceKind,
        attribution: input.attribution ?? '',
        isDefault: input.isDefault ?? false,
        createdBy: user.id,
      };
      if (input.thumbnailUrl !== undefined) {
        data.thumbnailUrl = input.thumbnailUrl;
      }
      if (input.config !== undefined) data.config = input.config;
      return tx.basemap.create({ data });
    });
  }

  async update(user: AuthUser, id: string, patch: UpdateBasemapInput) {
    this.assertAdmin(user);
    const current = await this.get(user, id);
    return this.prisma.$transaction(async (tx) => {
      if (patch.isDefault === true && !current.isDefault) {
        await tx.basemap.updateMany({
          where: { orgId: user.orgId, isDefault: true, NOT: { id } },
          data: { isDefault: false },
        });
      }
      const data: Prisma.BasemapUpdateInput = {};
      if (patch.label !== undefined) data.label = patch.label.trim();
      if (patch.description !== undefined) data.description = patch.description;
      if (patch.url !== undefined) data.url = patch.url.trim();
      if (patch.sourceKind !== undefined) data.sourceKind = patch.sourceKind;
      if (patch.attribution !== undefined) data.attribution = patch.attribution;
      if (patch.thumbnailUrl !== undefined) data.thumbnailUrl = patch.thumbnailUrl;
      if (patch.config !== undefined) {
        // null in the patch means "clear the JSON blob".
        data.config =
          patch.config === null ? Prisma.JsonNull : patch.config;
      }
      if (patch.isDefault !== undefined) data.isDefault = patch.isDefault;
      return tx.basemap.update({ where: { id }, data });
    });
  }

  async remove(user: AuthUser, id: string): Promise<void> {
    this.assertAdmin(user);
    await this.get(user, id); // ownership check
    await this.prisma.basemap.delete({ where: { id } });
  }

  private assertAdmin(user: AuthUser) {
    if (user.orgRole !== 'admin') {
      throw new ForbiddenException(
        'Only org admins can modify the basemap library.',
      );
    }
  }
}

