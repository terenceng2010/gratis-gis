import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { BackupService } from './backup.service.js';

/**
 * Registers the scheduled backup job at module init. We do this
 * imperatively (via SchedulerRegistry) rather than a @Cron decorator
 * so the expression is operator-configurable via BACKUP_SCHEDULE_CRON
 * without a redeploy. The job is skipped entirely when
 * BACKUP_SCHEDULE_DISABLED=true, which gives operators a quick
 * pressure-release valve if something is going wrong with the backup
 * path and they need time to debug without cron spam.
 */
@Injectable()
export class BackupCronService implements OnModuleInit {
  private readonly log = new Logger(BackupCronService.name);
  private static readonly JOB_NAME = 'backup-scheduled';

  constructor(
    private readonly backup: BackupService,
    private readonly scheduler: SchedulerRegistry,
    private readonly cfg: ConfigService,
  ) {}

  onModuleInit() {
    const disabled =
      (this.cfg.get<string>('BACKUP_SCHEDULE_DISABLED') || '').toLowerCase() ===
      'true';
    if (disabled) {
      this.log.warn(
        'Scheduled backups disabled (BACKUP_SCHEDULE_DISABLED=true). Manual runs still work.',
      );
      return;
    }

    const expr = this.cfg.get<string>('BACKUP_SCHEDULE_CRON', '0 2 * * *');
    let job: CronJob;
    try {
      job = new CronJob(expr, () => this.runSafely());
    } catch (e) {
      // Bad cron expression: fail loud once at boot rather than
      // silently never running. The admin UI's "scheduleDisabled"
      // flag stays false so we still surface the intent to run.
      this.log.error(
        `Invalid BACKUP_SCHEDULE_CRON="${expr}": ${(e as Error).message}. ` +
          'Scheduled backups will NOT run until this is fixed.',
      );
      return;
    }
    this.scheduler.addCronJob(BackupCronService.JOB_NAME, job);
    job.start();
    this.log.log(`Scheduled backup cron registered: ${expr}`);
  }

  /**
   * Guarded wrapper so a thrown error inside runBackup doesn't kill
   * the cron timer (CronJob swallows unhandled rejections, but we
   * want an explicit log line).
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
