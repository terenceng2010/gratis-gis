import { createReadStream } from 'node:fs';

import {
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

/**
 * Admin-only surface for the backup system. Scope: read config,
 * update config, list runs, start a run, download an archive,
 * delete a row. Restore lives in a separate flow (#62) because
 * mixing it into the same controller invites finger-memory
 * mistakes between "download last good" and "overwrite everything".
 */

const SCHEDULE_MODES = ['off', 'daily', 'weekly', 'monthly', 'custom'] as const;

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
  constructor(private readonly backup: BackupService) {}

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
}
