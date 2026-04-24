import { createReadStream } from 'node:fs';

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import type { Response } from 'express';

import { AdminGuard } from '../admin/admin.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { BackupService } from './backup.service.js';
import { BackupRestoreService } from './backup-restore.service.js';
import { MaintenanceModeService } from './maintenance-mode.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Admin-only surface for the backup system. Scope: read config,
 * update config, list runs, start a run, download an archive,
 * delete a row. Restore lives in a separate flow (#62) because
 * mixing it into the same controller invites finger-memory
 * mistakes between "download last good" and "overwrite everything".
 */

const SCHEDULE_MODES = ['off', 'daily', 'weekly', 'monthly', 'custom'] as const;

class RestoreConfirmDto {
  /** Must match the org slug of the portal the admin is restoring
   *  onto. This catches the "wrong portal" finger-memory mistake:
   *  you can't accidentally restore acme-corp's archive onto
   *  beta-industries just by clicking the button. */
  @IsString() @MaxLength(100)
  confirmSlug!: string;
}

class UpdateConfigDto {
  // archiveDirectory: string | null — empty string / null clears the
  // override so the env BACKUP_DIR default comes back into play.
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  archiveDirectory?: string | null;

  @IsOptional()
  @IsEnum(SCHEDULE_MODES)
  scheduleMode?: (typeof SCHEDULE_MODES)[number];

  @IsOptional() @IsInt() @Min(0) @Max(23)
  scheduleHour?: number;

  @IsOptional() @IsInt() @Min(0) @Max(59)
  scheduleMinute?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt() @Min(0) @Max(6)
  scheduleDayOfWeek?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt() @Min(1) @Max(28)
  scheduleDayOfMonth?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString() @MaxLength(120)
  customCron?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt() @Min(1) @Max(1000)
  retentionCount?: number | null;
}

@ApiTags('admin', 'backup')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/backup')
export class BackupController {
  constructor(
    private readonly backup: BackupService,
    private readonly restore: BackupRestoreService,
    private readonly mode: MaintenanceModeService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('config')
  getConfig() {
    return this.backup.getConfig();
  }

  @Patch('config')
  async updateConfig(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateConfigDto,
  ) {
    // Passing the whole DTO works because every key matches the
    // patch shape on the service side; the service itself does the
    // range / enum / cron-shape validation that class-validator
    // can't express cleanly.
    return this.backup.updateConfig(dto, user.id);
  }

  @Get('runs')
  async listRuns() {
    // BigInt doesn't JSON.stringify natively; cast sizeBytes to
    // string here so the admin page can format it without a runtime
    // surprise. (Keeping BigInt in the DB is still worth it — it's
    // the right domain type for "bytes of a backup archive".)
    const runs = await this.backup.listRuns();
    return runs.map((r) => ({
      ...r,
      sizeBytes: r.sizeBytes === null ? null : r.sizeBytes.toString(),
    }));
  }

  @Post('runs')
  async runNow(@CurrentUser() user: AuthUser) {
    const run = await this.backup.runBackup('manual', user.id);
    return {
      ...run,
      sizeBytes:
        run.sizeBytes === null ? null : (run.sizeBytes as bigint).toString(),
    };
  }

  /**
   * Stream the archive bytes back to the admin. Express needs the
   * @Res() escape hatch because Nest's JSON response pipeline
   * doesn't fit a multi-gigabyte binary download.
   */
  @Get('runs/:id/download')
  async download(
    @Param('id') id: string,
    @Res({ passthrough: false }) res: Response,
  ) {
    const { path: p, filename } = await this.backup.resolveArchivePath(id);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    createReadStream(p).pipe(res);
  }

  @Delete('runs/:id')
  async remove(@Param('id') id: string) {
    return this.backup.deleteRun(id);
  }

  // ---------------------------------------------------------------
  // Restore — separate namespace to keep the finger-memory hazard
  // ("I meant Delete, not Restore") away from the normal flow.
  // ---------------------------------------------------------------

  /**
   * Preview what the archive contains without touching anything.
   * The UI calls this first so the admin sees "you are about to
   * restore a backup from Tuesday with 340 items + 52 MB of
   * uploads" before hitting the scary button.
   */
  @Get('runs/:id/restore/preview')
  async restorePreview(@Param('id') id: string) {
    return this.restore.peekArchive(id);
  }

  /**
   * Execute the destructive restore. Admin must pass the current
   * org slug as `confirmSlug` — if it doesn't match, we refuse
   * before even reading the archive.
   */
  @Post('runs/:id/restore')
  async runRestore(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RestoreConfirmDto,
  ) {
    // The current org slug is the confirmation token. This is the
    // cheapest "are you sure?" gate that actually catches the
    // common mistake (wrong portal / wrong archive).
    const org = await this.prisma.organization.findFirst({
      where: { id: user.orgId },
      select: { slug: true },
    });
    if (!org) {
      throw new BadRequestException('Could not resolve your organization.');
    }
    if (dto.confirmSlug !== org.slug) {
      throw new BadRequestException(
        `Confirmation slug "${dto.confirmSlug}" does not match this portal's slug "${org.slug}". Refusing to restore.`,
      );
    }

    // Flip maintenance mode BEFORE we touch anything; the global
    // middleware then 503s unrelated requests that are in flight or
    // arriving during the restore window.
    this.mode.activate(
      `Restoring backup ${id.slice(0, 8)}… Initiated by ${user.username ?? user.id.slice(0, 8)}.`,
    );
    try {
      const audit = await this.restore.runRestore({
        runId: id,
        startedBy: user.id,
      });
      return audit;
    } finally {
      // Always turn maintenance mode off, even if the restore
      // threw mid-way. Better to surface whatever post-restore
      // state the DB is in than leave the portal unreachable.
      this.mode.deactivate();
    }
  }

  /** Status endpoint the UI polls while a restore is in flight. */
  @Get('restore/status')
  async restoreStatus() {
    const maintenance = this.restore.maintenanceSnapshot();
    const recent = await this.restore.recentRestores(5);
    return { maintenance, recent };
  }
}
