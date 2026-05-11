// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { GeocodingService } from './geocoding.service.js';

/**
 * Runtime geocoding endpoint for geocoding_service items (#74).
 *
 * `GET /geocode/:itemId?text=<query>&bbox=<w,s,e,n>&limit=<n>`
 *
 * Auth: standard JWT guard. The service-layer authz checks ensure
 * the caller has read access to BOTH the geocoder item and the
 * underlying data_layer.
 */
@ApiTags('geocoding')
@ApiBearerAuth()
@Controller('geocode')
@UseGuards(JwtAuthGuard)
export class GeocodingController {
  constructor(private readonly geocoding: GeocodingService) {}

  @Get(':itemId')
  async search(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Query('text') text?: string,
    @Query('bbox') bbox?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedBbox = parseBbox(bbox);
    const parsedLimit = parseLimit(limit);
    const opts: {
      bbox?: [number, number, number, number];
      limit?: number;
    } = {};
    if (parsedBbox) opts.bbox = parsedBbox;
    if (parsedLimit !== null) opts.limit = parsedLimit;
    const candidates = await this.geocoding.search(
      user,
      itemId,
      text ?? '',
      opts,
    );
    return { candidates };
  }
}

/** Parse the comma-separated `bbox=w,s,e,n` query param. Returns
 *  null when the param is absent or malformed; the caller treats
 *  null as "no spatial constraint from the request" and falls back
 *  to the geocoder's configured bboxFilter. */
function parseBbox(
  raw: string | undefined,
): [number, number, number, number] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new BadRequestException(
      'bbox must be four comma-separated numbers: west,south,east,north',
    );
  }
  const [w, s, e, n] = parts as [number, number, number, number];
  if (w >= e || s >= n) {
    throw new BadRequestException(
      'bbox has invalid ordering: west must be < east, south must be < north',
    );
  }
  return [w, s, e, n];
}

function parseLimit(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new BadRequestException('limit must be a positive integer');
  }
  return Math.floor(n);
}
