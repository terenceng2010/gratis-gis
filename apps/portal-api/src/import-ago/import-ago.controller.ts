// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';

import { AdminGuard } from '../admin/admin.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

import { AgoDryRunService, type DryRunReport } from './dry-run.js';
import { AgoImportService, type ImportReport } from './import.js';

/**
 * DTOs.
 *
 * Token + URL are sent on every request rather than persisted
 * via a long-lived "AGO portal connection" item. v1 keeps the
 * credential surface narrow: an operator pastes a token into
 * the dialog, runs the import, and the token never touches the
 * portal's DB. Phase 5 (workstream 3 in next-workstreams.md)
 * can add credential persistence once the multi-portal admin
 * UX is fleshed out.
 */
class AgoPreviewDto {
  @IsString()
  portalUrl!: string;

  @IsString()
  token!: string;

  /** Optional explicit username; defaults to the username
   *  returned by /portals/self. */
  @IsString()
  @IsOptional()
  username?: string;
}

class AgoRunDto {
  @IsString()
  portalUrl!: string;

  @IsString()
  token!: string;

  /** The dry-run report from a previous /preview call. The
   *  worker doesn't re-walk AGO; it acts on whatever the
   *  preview captured so the user sees what they signed up for. */
  @IsObject()
  report!: DryRunReport;
}

/**
 * Admin-only HTTP surface for the AGO migration importer.
 * Two endpoints:
 *
 *   - POST /admin/import-ago/preview
 *     Walks the AGO portal, classifies items, returns a
 *     ``DryRunReport``. Read-only, idempotent.
 *
 *   - POST /admin/import-ago/run
 *     Takes a previously-fetched report + the connection
 *     credentials, creates portal items for everything the
 *     report says should be imported, returns an
 *     ``ImportReport`` with per-item outcomes.
 *
 * Both endpoints are gated by ``AdminGuard`` because the
 * importer creates items on the user's behalf and connects
 * outbound to an arbitrary AGO portal. A future phase can open
 * this up to contributors with finer-grained credential
 * scoping.
 */
@ApiBearerAuth()
@ApiTags('admin', 'import-ago')
@Controller('admin/import-ago')
@UseGuards(AdminGuard)
export class ImportAgoController {
  constructor(
    private readonly dryRun: AgoDryRunService,
    private readonly importer: AgoImportService,
  ) {}

  @Post('preview')
  async preview(@Body() dto: AgoPreviewDto): Promise<DryRunReport> {
    if (!isHttpsUrl(dto.portalUrl)) {
      throw new BadRequestException(
        'portalUrl must be an https:// URL ending at the /sharing/rest root.',
      );
    }
    return this.dryRun.run({
      portalUrl: dto.portalUrl,
      token: dto.token,
      ...(dto.username !== undefined ? { username: dto.username } : {}),
    });
  }

  @Post('run')
  async run(
    @CurrentUser() user: AuthUser,
    @Body() dto: AgoRunDto,
  ): Promise<ImportReport> {
    if (!isHttpsUrl(dto.portalUrl)) {
      throw new BadRequestException(
        'portalUrl must be an https:// URL ending at the /sharing/rest root.',
      );
    }
    if (!dto.report || !Array.isArray(dto.report.items)) {
      throw new BadRequestException(
        'report must be the DryRunReport returned from /preview.',
      );
    }
    return this.importer.run({
      user,
      portalUrl: dto.portalUrl,
      token: dto.token,
      report: dto.report,
    });
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}
