import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../admin/admin.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FieldQueueService, type ManifestEntry } from './field-queue.service.js';

/**
 * Admin-only view of every device-manifest beacon in the org. Pure
 * read endpoint: the admin's recourse on a stuck queue is to reach
 * out to the worker, not to mutate state from this surface (the
 * record payloads aren't here anyway). See
 * docs/field-offline-areas.md, Tier 4.
 */
@ApiTags('admin', 'field')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/field-queues')
export class FieldQueueAdminController {
  constructor(
    private readonly service: FieldQueueService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const rows = await this.service.listManifestsForOrg(user.orgId);

    // Resolve each dataCollectionId in the manifest to the item's
    // human-readable title so the admin sees "Maple Street Survey"
    // instead of a raw uuid. Scoped to the admin's org so a manifest
    // referencing an item that has since moved orgs (rare) renders as
    // unknown rather than leaking a title across the tenant boundary.
    const ids = new Set<string>();
    for (const row of rows) {
      const manifest = (row.manifest as ManifestEntry[] | null) ?? [];
      for (const entry of manifest) {
        if (entry?.dataCollectionId) ids.add(entry.dataCollectionId);
      }
    }
    const items =
      ids.size === 0
        ? []
        : await this.prisma.item.findMany({
            where: { id: { in: [...ids] }, orgId: user.orgId },
            select: { id: true, title: true, deletedAt: true },
          });
    const titleById = new Map(
      items.map((i) => [
        i.id,
        { title: i.title, deleted: i.deletedAt !== null },
      ]),
    );

    return rows.map((row) => {
      const manifest = (row.manifest as ManifestEntry[] | null) ?? [];
      const enriched = manifest.map((entry) => {
        const meta = titleById.get(entry.dataCollectionId);
        return {
          ...entry,
          dataCollectionTitle: meta?.title ?? null,
          dataCollectionDeleted: meta?.deleted ?? false,
        };
      });
      return {
        id: row.id,
        userId: row.userId,
        username: row.user.username,
        email: row.user.email,
        fullName: row.user.fullName,
        deviceFingerprint: row.deviceFingerprint,
        // Cast bigints to numbers for the JSON response. The values are
        // bytes from navigator.storage.estimate(), well inside JS-safe
        // range; we capped on the way in.
        storageUsage:
          row.storageUsage === null ? null : Number(row.storageUsage),
        storageQuota:
          row.storageQuota === null ? null : Number(row.storageQuota),
        userAgent: row.userAgent,
        reportedAt: row.reportedAt.toISOString(),
        manifest: enriched,
      };
    });
  }
}
