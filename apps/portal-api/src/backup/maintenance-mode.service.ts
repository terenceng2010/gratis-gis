// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';

/**
 * In-memory flag that the restore flow raises while it's actively
 * rewriting the database + object store. A global middleware reads
 * this and short-circuits unrelated requests with 503 so a live
 * user session can't race with a destructive restore.
 *
 * In-memory is the right call for Phase 1: a single portal-api
 * process, no horizontal scale, and the restore can only be
 * triggered on the same process that will handle the rest of the
 * requests. If we ever run multiple replicas, the flag should move
 * to Redis / Postgres.
 */
@Injectable()
export class MaintenanceModeService {
  private readonly log = new Logger(MaintenanceModeService.name);
  private active = false;
  private reason: string | null = null;
  private startedAt: Date | null = null;

  isActive(): boolean {
    return this.active;
  }

  snapshot() {
    return {
      active: this.active,
      reason: this.reason,
      startedAt: this.startedAt?.toISOString() ?? null,
    };
  }

  activate(reason: string) {
    if (this.active) {
      this.log.warn(
        `activate() called while maintenance mode was already on (reason: ${this.reason}); keeping original reason + timestamp`,
      );
      return;
    }
    this.active = true;
    this.reason = reason;
    this.startedAt = new Date();
    this.log.warn(`Maintenance mode ON: ${reason}`);
  }

  deactivate() {
    if (!this.active) return;
    this.log.log(
      `Maintenance mode OFF (was on for ${Math.round(
        (Date.now() - (this.startedAt?.getTime() ?? Date.now())) / 1000,
      )}s)`,
    );
    this.active = false;
    this.reason = null;
    this.startedAt = null;
  }
}
