// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { BackupService, type BackupConfig } from './backup.service.js';

/**
 * Registers the scheduled backup job and keeps it in sync with the
 * admin-editable config. We own the single CronJob identity under
 * SchedulerRegistry; BackupService.onConfigChange lets the admin
 * form push a new expression here and we tear down + re-register
 * without a restart.
 *
 * Mode === 'off' means no job at all: we deregister whatever's
 * running and don't register a replacement. Flipping back to 'daily'
 * (or whatever) from the admin form re-registers from scratch.
 */
@Injectable()
export class BackupCronService implements OnModuleInit {
  private readonly log = new Logger(BackupCronService.name);
  private static readonly JOB_NAME = 'backup-scheduled';

  constructor(
    private readonly backup: BackupService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  async onModuleInit() {
    // Load the effective config (DB row merged over env) and
    // register the job for the first time. Then subscribe so every
    // subsequent admin save re-applies the schedule.
    const cfg = await this.backup.getConfig();
    this.apply(cfg);
    this.backup.onConfigChange((next) => this.apply(next));
  }

  /**
   * Tear down the existing cron (if any) and register one that
   * matches the given effective config. Invalid cron expressions
   * are logged loudly and left un-registered; the admin can fix
   * them in the UI and save again without restarting the process.
   */
  private apply(cfg: BackupConfig) {
    this.unregister();

    if (cfg.scheduleMode === 'off') {
      this.log.log(
        'Automatic backups are turned off; manual runs still work.',
      );
      return;
    }

    const expr = cfg.effectiveCron;
    if (!expr) {
      this.log.warn(
        `Schedule mode is "${cfg.scheduleMode}" but no cron expression ` +
          'resolved; scheduled backups will not run until the config is fixed.',
      );
      return;
    }

    let job: CronJob;
    try {
      job = new CronJob(expr, () => this.runSafely());
    } catch (e) {
      this.log.error(
        `Invalid cron expression "${expr}": ${(e as Error).message}. ` +
          'Scheduled backups will NOT run until this is fixed.',
      );
      return;
    }
    this.scheduler.addCronJob(BackupCronService.JOB_NAME, job);
    job.start();
    this.log.log(
      `Scheduled backup registered: ${cfg.scheduleSummary} (${expr})`,
    );
  }

  private unregister() {
    try {
      const existing = this.scheduler.getCronJob(BackupCronService.JOB_NAME);
      if (existing) {
        existing.stop();
        this.scheduler.deleteCronJob(BackupCronService.JOB_NAME);
      }
    } catch {
      // getCronJob throws when the name isn't registered; that's
      // fine on first boot and after an off→on transition.
    }
  }

  /**
   * Guarded wrapper so a thrown error inside runBackup doesn't kill
   * the cron timer.
   */
  private async runSafely() {
    try {
      const res = await this.backup.runBackup('scheduled', null);
      this.log.log(
        `Scheduled backup ${res.id} finished: status=${res.status}`,
      );
    } catch (e) {
      this.log.error(
        `Scheduled backup threw: ${(e as Error).message}`,
      );
    }
  }
}
