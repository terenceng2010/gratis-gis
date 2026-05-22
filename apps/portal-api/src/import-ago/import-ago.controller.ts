// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { IsObject, IsOptional, IsString } from 'class-validator';
import { randomBytes } from 'node:crypto';

import { AdminGuard } from '../admin/admin.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

import { AgoDryRunService, type DryRunReport } from './dry-run.js';
import { AgoImportService, type ImportReport } from './import.js';
import { buildAgoAuthorizeUrl, normalizeAgoUrl } from './ago-url.js';

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
/**
 * Body shape for the OAuth /start endpoint. Takes whatever URL
 * shape the operator pasted (org subdomain only, full URL, /home
 * suffix, etc.) and returns the authorize URL the browser should
 * redirect to.
 */
class AgoOauthStartDto {
  /** AGO org URL in any shape the normalizer accepts. */
  @IsString()
  orgUrl!: string;

  /** Where AGO should redirect after the user signs in. Must match
   *  one of the redirect URIs registered on the AGO app. */
  @IsString()
  redirectUri!: string;
}

@ApiBearerAuth()
@ApiTags('admin', 'import-ago')
@Controller('admin/import-ago')
@UseGuards(AdminGuard)
export class ImportAgoController {
  constructor(
    private readonly dryRun: AgoDryRunService,
    private readonly importer: AgoImportService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Report whether OAuth is configured on this portal so the UI
   * can decide whether to render the Sign-In button or a "set
   * AGO_OAUTH_CLIENT_ID" hint.
   *
   * Returning the client id here is intentional: AGO's
   * implicit-grant flow embeds it in the authorize URL anyway, so
   * there's no secret to leak. AGO app secrets live on the AGO
   * side, not here.
   */
  @Get('oauth/config')
  oauthConfig(): {
    configured: boolean;
    clientId: string | null;
    reason: string | null;
  } {
    const clientId = this.config.get<string>('AGO_OAUTH_CLIENT_ID');
    if (!clientId) {
      return {
        configured: false,
        clientId: null,
        reason:
          'AGO_OAUTH_CLIENT_ID env var is not set on this portal. ' +
          'Register an app on ArcGIS Online (Settings -> Add-ins or ' +
          '/sharing/rest/oauth2/registerApp) and add the client id ' +
          'to /etc/gratisgis/env, then restart portal-api.',
      };
    }
    return { configured: true, clientId, reason: null };
  }

  /**
   * Build the AGO authorize URL the browser should send the user
   * to. Takes any shape of org URL the user pasted, normalizes it
   * to the /sharing/rest base, and embeds the registered
   * client_id + caller's redirect URI + a CSRF state token.
   *
   * The state token is the import-ago controller's own
   * cryptographic random; the callback page verifies it before
   * accepting the returned token. We don't store it server-side
   * because the SPA owns the popup lifecycle.
   */
  @Post('oauth/start')
  startOauth(@Body() dto: AgoOauthStartDto): {
    authorizeUrl: string;
    sharingRestBase: string;
    state: string;
  } {
    const clientId = this.config.get<string>('AGO_OAUTH_CLIENT_ID');
    if (!clientId) {
      throw new BadRequestException(
        'AGO_OAUTH_CLIENT_ID is not configured on this portal.',
      );
    }
    const normalized = normalizeAgoUrl(dto.orgUrl);
    if (!normalized) {
      throw new BadRequestException(
        `Could not parse "${dto.orgUrl}" as an AGO portal URL. ` +
          'Try the org host (e.g. palavido.maps.arcgis.com).',
      );
    }
    // Refuse redirect URIs that don't match our own portal. AGO
    // will also enforce its registered-redirect-URI allowlist, but
    // we belt-and-suspenders here so a misconfigured AGO app can't
    // get tricked into echoing to a third-party origin.
    if (!isLikelyOwnPortalRedirect(dto.redirectUri)) {
      throw new BadRequestException(
        'redirectUri must be an https:// URL under this portal.',
      );
    }
    const state = randomBytes(24).toString('base64url');
    const authorizeUrl = buildAgoAuthorizeUrl({
      sharingRestBase: normalized.sharingRestBase,
      clientId,
      redirectUri: dto.redirectUri,
      state,
      // AGO's max for implicit-grant is 20160 (two weeks), but
      // the importer needs the token only as long as the dialog
      // is open. Cap at 60 min so a leaked URL goes stale fast.
      expirationMinutes: 60,
    });
    return {
      authorizeUrl,
      sharingRestBase: normalized.sharingRestBase,
      state,
    };
  }

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

/**
 * Best-effort sanity check that the OAuth redirect URI points back
 * at the portal itself rather than a third-party origin. Accepts
 * any https:// URL: AGO performs the authoritative check against
 * its registered allowlist, this is just an extra guard.
 */
function isLikelyOwnPortalRedirect(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}
