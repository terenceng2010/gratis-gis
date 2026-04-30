import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../admin/admin.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { FieldQueueService } from './field-queue.service.js';

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
  constructor(private readonly service: FieldQueueService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const rows = await this.service.listManifestsForOrg(user.orgId);
    return rows.map((row) => ({
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
      manifest: row.manifest,
    }));
  }
}
