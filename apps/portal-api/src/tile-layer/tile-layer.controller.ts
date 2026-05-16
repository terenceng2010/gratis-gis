// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { TileLayerService } from './tile-layer.service.js';

/**
 * HTTP surface for tile_layer items (#179).
 *
 *   POST /items/:id/tile-layer/finalize
 *     Called by the frontend after a successful presigned-PUT
 *     upload to MinIO. Reads the PMTiles header from the
 *     just-uploaded file, extracts metadata, persists it on
 *     item.data. Returns the populated TileLayerData.
 *
 *   GET /tile-layer/:itemId/file
 *     Proxy endpoint MapLibre's pmtiles plugin range-reads.
 *     Forwards the Range header to the file's public MinIO URL
 *     and streams the response back. Item-level ACL applies via
 *     ItemsService.get inside resolveStorageUrl().
 */
@ApiTags('tile-layer')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class TileLayerController {
  constructor(private readonly tileLayer: TileLayerService) {}

  @Post('items/:itemId/tile-layer/finalize')
  async finalize(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Body()
    body: {
      storageKey: string;
      storageUrl: string;
      fileName: string;
      sizeBytes: number;
    },
  ) {
    const data = await this.tileLayer.finalizeUpload(user, itemId, body);
    return { data };
  }

  /**
   * Pre-upload space check.  Frontend calls this on file select
   * (before requesting a presigned PUT) so a too-big upload is
   * refused up front instead of hammering MinIO with ENOSPC after
   * megabytes of bytes have already been transferred.  Returns
   * `ok: false` plus a user-readable reason when the host disk
   * doesn't have headroom for the upload + conversion pipeline.
   * No `itemId` in the path because the check is purely about
   * disk space; the create-item flow can call this before the
   * item exists.
   */
  @Post('tile-layer/check-space')
  async checkSpace(
    @CurrentUser() _user: AuthUser,
    @Body()
    body: {
      fileName: string;
      sizeBytes: number;
    },
  ) {
    return this.tileLayer.checkUploadSpace(body);
  }

  /**
   * Range-request proxy. MapLibre's pmtiles plugin issues many
   * range requests as the user pans / zooms; this endpoint
   * forwards each one to the underlying MinIO public URL. We
   * resolve the file URL on every call so a revoked item access
   * stops working immediately (no client-side URL caching to
   * worry about for ACL purposes).
   *
   * Implementation: do a server-side fetch with the same Range
   * header, then mirror the response status + Content-Range +
   * Content-Length headers and pipe the body through. This is
   * less efficient than a redirect would be, but a redirect to
   * a presigned URL would expire mid-session, and proxying lets
   * us apply per-request ACL checks (cheap; just an items.get
   * read inside the service).
   */
  @Get('tile-layer/:itemId/file')
  async serveFile(
    @CurrentUser() user: AuthUser,
    @Param('itemId') itemId: string,
    @Headers('range') rangeHeader: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const storageUrl = await this.tileLayer.resolveStorageUrl(user, itemId);
    const headers: Record<string, string> = {};
    if (rangeHeader) headers['range'] = rangeHeader;
    // Suppress the express body parser - we stream the raw bytes
    // straight through.
    const upstream = await fetch(storageUrl, { headers });
    res.status(upstream.status);
    const cr = upstream.headers.get('content-range');
    if (cr) res.setHeader('Content-Range', cr);
    const cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    const etag = upstream.headers.get('etag');
    if (etag) res.setHeader('ETag', etag);
    // Range support: advertise so MapLibre + browsers know to
    // request slices.
    res.setHeader('Accept-Ranges', 'bytes');
    // PMTiles content is immutable per upload (a new upload
    // produces a new storageKey + url), so we can let the
    // browser cache aggressively. ETag handles invalidation when
    // a tile layer's file is replaced.
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');

    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    // Manual stream-to-express copy; res.write returns false when
    // the buffer is full and we should wait for drain. Avoids
    // memory pressure on large tiles.
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      }
      res.end();
    } catch (err) {
      // Client disconnected mid-stream is normal (panning kills
      // in-flight tile fetches). Log unexpected errors only.
      if (!req.destroyed) {
        // eslint-disable-next-line no-console
        console.error('tile-layer proxy stream error', err);
      }
      try {
        res.end();
      } catch {
        /* response may already be closed */
      }
    }
  }
}
