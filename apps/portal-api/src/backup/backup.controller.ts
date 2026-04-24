import { createReadStream } from 'node:fs';

import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { AdminGuard } from '../admin/admin.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { BackupService } from './backup.service.js';

/**
 * Admin-only surface for the backup system. The shape is deliberately
 * thin: GET config (read-only ops knobs), list runs, start a run,
 * download an archive, delete a row. Restore lives elsewhere (will
 * be added in #59-restore) because mixing "download the last good
 * copy" with "overwrite everything from this archive" in one
 * controller risks a copy-paste mistake between the two.
 */
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
