import {
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../admin/admin.guard.js';
import { HousekeepingScheduleService } from '../admin/housekeeping-schedule.service.js';
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
    private readonly schedule: HousekeepingScheduleService,
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

  /**
   * #275: Forget a single manifest row. Pure metadata wipe -- the
   * record payloads live on the device, not here. The next beacon
   * from that device re-creates the row if it's still in use.
   *
   * Scoped to the admin's own org (a row from another tenant 404s
   * rather than disclosing existence). Uses the unique row id so
   * the admin's UI can target a specific (user, device) pair
   * without having to repeat the fingerprint hash.
   */
  @Delete(':id')
  async forget(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    // Verify the row belongs to a user in the admin's org before
    // deleting. The User -> orgId join keeps tenant isolation
    // honest even though FieldQueueManifest doesn't carry orgId
    // directly.
    const row = await this.prisma.fieldQueueManifest.findUnique({
      where: { id },
      select: { id: true, user: { select: { orgId: true } } },
    });
    if (!row || row.user.orgId !== user.orgId) {
      throw new NotFoundException('Manifest not found');
    }
    await this.prisma.fieldQueueManifest.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * #275 / #276: Bulk Forget all stale manifests in this org.
   * "Stale" means: the manifest is empty (no queued records
   * anywhere) AND the last beacon was more than fieldQueueStaleDays
   * (default 7) ago. The threshold reads from the configurable
   * housekeeping config so admin tweaks land here without code
   * changes. Returns the count deleted so the UI can confirm.
   */
  @Post('forget-stale')
  async forgetStale(@CurrentUser() user: AuthUser) {
    const cfg = await this.schedule.getConfig();
    const days = cfg.fieldQueueStaleDays;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    // Pull candidates first so we can apply the JSON-shape predicate
    // (manifest is jsonb, the queuedRecords array on each entry has
    // to be empty for the row to count as stale). Doing this in
    // application code is straightforward; a SQL-side jsonb filter
    // would work too but the row count is small (one per device).
    const rows = await this.prisma.fieldQueueManifest.findMany({
      where: {
        user: { orgId: user.orgId },
        reportedAt: { lt: cutoff },
      },
      select: { id: true, manifest: true },
    });
    const stale = rows.filter((r) => {
      const m = (r.manifest as ManifestEntry[] | null) ?? [];
      return m.every((entry) => (entry.queuedRecords?.length ?? 0) === 0);
    });
    if (stale.length === 0) {
      return { ok: true, deleted: 0 };
    }
    const result = await this.prisma.fieldQueueManifest.deleteMany({
      where: { id: { in: stale.map((r) => r.id) } },
    });
    return { ok: true, deleted: result.count };
  }
}
