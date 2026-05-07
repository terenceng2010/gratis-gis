// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Permanently deletes rows from the trash once their retention window
 * has elapsed. Runs nightly; see docs/soft-delete.md for the user-
 * visible contract.
 *
 * Why a scheduled job rather than a per-request check:
 *   - Purge is a destructive operation we want audited in one place, not
 *     scattered through item/group code paths.
 *   - A nightly sweep cleanly handles "day 30" boundaries without
 *     depending on whoever happens to hit the site first that morning.
 *
 * The retention window is configurable via RECYCLE_BIN_RETENTION_DAYS;
 * default 30 matches every user-facing surface.
 */
@Injectable()
export class TrashPurgeService {
  private readonly log = new Logger(TrashPurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
  ) {}

  // 3am UTC keeps it off peak traffic for most deployments. Cron syntax
  // from @nestjs/schedule: "second minute hour day-of-month month day-of-week".
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'purge-trash' })
  async handleCron() {
    await this.purgeExpired();
  }

  /**
   * Exposed so admin tooling (or a dev "force now" button later) can
   * invoke the same code path the cron uses.
   */
  async purgeExpired() {
    const retentionDays = Number(
      this.cfg.get<string>('RECYCLE_BIN_RETENTION_DAYS', '30'),
    );
    if (!Number.isFinite(retentionDays) || retentionDays < 1) {
      this.log.warn(
        `RECYCLE_BIN_RETENTION_DAYS=${retentionDays} is invalid, skipping purge`,
      );
      return { items: 0, groups: 0 };
    }

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const [items, groups] = await this.prisma.$transaction([
      this.prisma.item.deleteMany({ where: { deletedAt: { lt: cutoff } } }),
      this.prisma.group.deleteMany({ where: { deletedAt: { lt: cutoff } } }),
    ]);

    this.log.log(
      `Purge swept trash older than ${retentionDays}d: items=${items.count}, groups=${groups.count}`,
    );
    return { items: items.count, groups: groups.count };
  }
}
