// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PMTiles, Source, RangeResponse, Header } from 'pmtiles';
import { Prisma } from '@prisma/client';
import type { TileLayerData, ISODateString } from '@gratis-gis/shared-types';
import { isTileLayerData } from '@gratis-gis/shared-types';

import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import { StorageService } from '../storage/storage.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  cleanupConversion,
  convertToPmtiles,
  detectOriginalFormat,
} from './tile-conversion.js';

/**
 * Service for the tile_layer item type (#179).
 *
 * Two responsibilities:
 *
 *   1. After a browser uploads a .pmtiles file directly to MinIO
 *      via the presigned PUT minted by StorageService, the client
 *      calls finalizeUpload(). We read the file header via HTTP
 *      range requests against the MinIO public URL, extract the
 *      metadata (min/max zoom, bbox, center, tile type,
 *      attribution, name, description), and persist it on the
 *      item's data_json. Subsequent renders read from item.data
 *      without re-parsing the header.
 *
 *   2. proxyTileRequest() serves the bytes for the API's pmtiles
 *      proxy endpoint. MapLibre's pmtiles plugin range-reads this
 *      URL, so we have to honor the Range header. We do that by
 *      passing it through to MinIO's presigned GET; MinIO returns
 *      a 206 with the requested byte range and we stream it back
 *      to the caller. Zero per-tile compute on our side; the cost
 *      is one S3-API hop per range request.
 *
 * Why a proxy endpoint instead of letting the browser hit MinIO
 * directly: the MinIO bucket is anonymous-read by design for
 * stable URLs, but a static URL stored on the item baked into a
 * map would leak across orgs once shared. Proxying through the
 * API lets us apply the item's read ACL (the same gate as every
 * other item endpoint), and gives us an obvious spot to add
 * caching or hot-tile prefetching later.
 */
@Injectable()
export class TileLayerService {
  private readonly log = new Logger(TileLayerService.name);

  constructor(
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Called by the frontend after it has PUT the bytes to MinIO
   * via the presigned URL. We read the PMTiles header to extract
   * metadata, compose the tile-URL the basemap editor will
   * surface, and persist everything into item.data.
   */
  async finalizeUpload(
    user: AuthUser,
    itemId: string,
    input: {
      storageKey: string;
      storageUrl: string;
      fileName: string;
      sizeBytes: number;
    },
  ): Promise<TileLayerData> {
    const item = await this.items.get(user, itemId);
    if (item.type !== 'tile_layer') {
      throw new BadRequestException(`Item ${itemId} is not a tile_layer.`);
    }
    if (!this.sharing.canAdmin(user, item)) {
      throw new ForbiddenException(
        'Only the owner or an org admin can attach a tile file to this item.',
      );
    }
    if (typeof input.storageKey !== 'string' || input.storageKey.length === 0) {
      throw new BadRequestException('storageKey is required');
    }
    if (typeof input.storageUrl !== 'string' || input.storageUrl.length === 0) {
      throw new BadRequestException('storageUrl is required');
    }
    if (typeof input.fileName !== 'string' || input.fileName.length === 0) {
      throw new BadRequestException('fileName is required');
    }
    if (
      typeof input.sizeBytes !== 'number' ||
      !Number.isFinite(input.sizeBytes) ||
      input.sizeBytes <= 0
    ) {
      throw new BadRequestException('sizeBytes must be a positive number');
    }
    // Detect upload format. detectOriginalFormat throws a
    // BadRequest-readable error for TPK / unknown extensions; we
    // re-wrap it as a Nest exception so the response shape stays
    // consistent.
    let originalFormat;
    try {
      originalFormat = detectOriginalFormat(input.fileName);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Unsupported file type',
      );
    }

    // For non-pmtiles uploads, run the converter to produce a
    // .pmtiles file we can serve through the range-request path.
    // For pmtiles uploads this is a no-op (the bytes are already
    // in MinIO at the right shape). Either way, after this block
    // `effectiveStorageKey` / `effectiveStorageUrl` point at the
    // serving file.
    let effectiveStorageKey = input.storageKey;
    let effectiveStorageUrl = input.storageUrl;
    let conversionMs = 0;
    let conversionWorkDir = '';
    try {
      if (originalFormat !== 'pmtiles') {
        const conv = await convertToPmtiles(input.storageUrl, input.fileName);
        conversionWorkDir = conv.workDir;
        conversionMs = conv.durationMs;
        // Upload the converted .pmtiles back to MinIO under a
        // fresh key. The original upload (mbtiles / zip) is
        // deleted once the new key is in place; we keep only the
        // converted serving format on long-term storage.
        if (conv.outputPath) {
          const uploaded = await this.storage.uploadLocalFile(
            'item-tile-layer',
            conv.outputPath,
            'application/octet-stream',
          );
          effectiveStorageKey = uploaded.key;
          effectiveStorageUrl = uploaded.publicUrl;
          // Best-effort delete of the original upload. A failed
          // delete leaks bytes in MinIO but doesn't break the
          // tile_layer item; the orphan accounting card surfaces
          // it. Tracked separately from the item lifecycle.
          try {
            await this.storage.deleteObject(input.storageKey);
          } catch (err) {
            this.log.warn(
              `Failed to delete original upload ${input.storageKey}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      }
    } catch (err) {
      // Clean up any temp dir the converter created before
      // re-raising. The original upload stays in MinIO so the
      // user can retry without re-uploading.
      if (conversionWorkDir) await cleanupConversion(conversionWorkDir);
      throw new BadRequestException(
        `Conversion failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (conversionWorkDir) await cleanupConversion(conversionWorkDir);

    // Read the PMTiles header via HTTP range requests against the
    // MinIO public URL. The pmtiles library handles directory
    // walking and metadata parsing; we only need to provide a
    // Source that fetches byte ranges.
    let header: Header | null = null;
    let metadata: Record<string, unknown> = {};
    try {
      const source = new FetchRangeSource(effectiveStorageUrl);
      const pmt = new PMTiles(source);
      header = await pmt.getHeader();
      metadata = (await pmt.getMetadata()) as Record<string, unknown>;
    } catch (err) {
      this.log.warn(
        `Failed to parse PMTiles header at ${effectiveStorageUrl}: ${err instanceof Error ? err.message : err}`,
      );
      // Best-effort: keep the upload but persist with empty
      // metadata so the user can still try (the file might be
      // malformed or have an unusual variant). The detail page
      // surfaces this by showing "(metadata could not be read)".
    }

    const tileType = header ? tileTypeToken(header.tileType) : 'unknown';
    const data: TileLayerData = {
      version: 1,
      format: 'pmtiles',
      kind: tileType === 'mvt' ? 'vector' : 'raster',
      storageKey: effectiveStorageKey,
      storageUrl: effectiveStorageUrl,
      // Display name strips the original extension and replaces
      // with .pmtiles to reflect what's actually stored, but we
      // also keep the original filename below for provenance.
      fileName:
        originalFormat === 'pmtiles'
          ? input.fileName
          : input.fileName.replace(/\.(mbtiles|zip)$/i, '.pmtiles'),
      sizeBytes: input.sizeBytes,
      uploadedAt: new Date().toISOString() as ISODateString,
      originalFormat,
    };
    if (originalFormat !== 'pmtiles') {
      data.originalFileName = input.fileName;
      data.originalSizeBytes = input.sizeBytes;
      data.conversionMs = conversionMs;
    }
    // Only persist metadata fields that came back populated;
    // exactOptionalPropertyTypes refuses undefined assignments to
    // optional string/number fields, so we omit instead.
    if (header) {
      if (Number.isFinite(header.minZoom)) data.minZoom = header.minZoom;
      if (Number.isFinite(header.maxZoom)) data.maxZoom = header.maxZoom;
      if (
        Number.isFinite(header.minLon) &&
        Number.isFinite(header.minLat) &&
        Number.isFinite(header.maxLon) &&
        Number.isFinite(header.maxLat)
      ) {
        data.bbox = [
          header.minLon,
          header.minLat,
          header.maxLon,
          header.maxLat,
        ];
      }
      if (Number.isFinite(header.centerLon)) data.centerLng = header.centerLon;
      if (Number.isFinite(header.centerLat)) data.centerLat = header.centerLat;
      if (Number.isFinite(header.centerZoom))
        data.centerZoom = header.centerZoom;
      if (tileType !== 'unknown') data.tileType = tileType;
    }
    const attribution = pickString(metadata, 'attribution');
    if (attribution) data.attribution = attribution;
    const name = pickString(metadata, 'name');
    if (name) data.name = name;
    const description = pickString(metadata, 'description');
    if (description) data.description = description;

    // Compose the runtime URL the basemap editor will display.
    // MapLibre's pmtiles plugin keys off the `pmtiles://` prefix
    // and treats the rest as the HTTP URL to range-read from.
    // We use a relative path so the URL stays valid regardless of
    // which hostname the portal is served from (gratisgis.org vs
    // a custom domain a fork uses).
    data.tileUrl = `pmtiles:///api/portal/tile-layer/${itemId}/file`;

    // PATCH item.data through the normal items pipeline so any
    // downstream hooks (dependency extractor, bbox cache, etc.)
    // see the new state.
    // The shared-types TileLayerData interface doesn't have a
    // string index signature; Prisma's InputJsonValue wants one
    // for plain object types. Cast through Prisma.JsonObject to
    // match the pattern other services use when persisting typed
    // shapes into the polymorphic data_json column.
    await this.items.update(user, itemId, {
      data: data as unknown as Prisma.JsonObject,
    });
    return data;
  }

  /**
   * Resolve the storageUrl for a tile_layer item the caller has
   * read access to. Used by the proxy endpoint to know where to
   * forward range requests. NotFound when the caller can't read
   * the item; that's the ACL gate.
   */
  async resolveStorageUrl(user: AuthUser, itemId: string): Promise<string> {
    const item = await this.items.get(user, itemId);
    if (item.type !== 'tile_layer') {
      throw new BadRequestException(`Item ${itemId} is not a tile_layer.`);
    }
    const data: unknown = item.data;
    if (!isTileLayerData(data)) {
      throw new NotFoundException(
        'Tile layer has not been uploaded yet (or the upload finalize step did not run).',
      );
    }
    if (!data.storageUrl) {
      throw new NotFoundException('Tile layer file URL is missing.');
    }
    return data.storageUrl;
  }

  /**
   * Drop the MinIO object backing this tile layer. Called by the
   * items service during purge. Best-effort: a missing key is
   * fine (the item may have been created without the upload ever
   * completing).
   */
  async tearDownStorage(itemId: string, data: unknown): Promise<void> {
    if (!isTileLayerData(data)) return;
    const tl: TileLayerData = data;
    if (!tl.storageKey) return;
    try {
      await this.storage.deleteObject(tl.storageKey);
    } catch (err) {
      this.log.warn(
        `Failed to delete tile_layer storage object for item ${itemId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

/**
 * Translate the PMTiles header's `tileType` integer to the token
 * we persist on TileLayerData.tileType. Spec values:
 *   0 unknown, 1 mvt, 2 png, 3 jpeg, 4 webp, 5 avif.
 */
function tileTypeToken(
  t: number,
): 'mvt' | 'png' | 'jpg' | 'webp' | 'avif' | 'unknown' {
  switch (t) {
    case 1:
      return 'mvt';
    case 2:
      return 'png';
    case 3:
      return 'jpg';
    case 4:
      return 'webp';
    case 5:
      return 'avif';
    default:
      return 'unknown';
  }
}

function pickString(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = metadata[key];
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return undefined;
}

/**
 * pmtiles.Source adapter that range-reads a public HTTP URL with
 * the global fetch() (Node 20+). The pmtiles package ships a
 * built-in FetchSource but only for the browser; on the server
 * we need to provide our own minimal implementation.
 *
 * Caches the etag so re-reads of the same file across calls
 * benefit from PMTiles's own directory cache. We deliberately
 * don't add a higher-level cache here; the package caches
 * decoded directories internally and the header itself is small.
 */
class FetchRangeSource implements Source {
  private etag?: string;

  constructor(private readonly url: string) {}

  getKey(): string {
    return this.url;
  }

  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<RangeResponse> {
    const headers: Record<string, string> = {
      Range: `bytes=${offset}-${offset + length - 1}`,
    };
    if (this.etag) headers['If-Match'] = this.etag;
    const init: RequestInit = { headers };
    if (signal) init.signal = signal;
    const res = await fetch(this.url, init);
    if (res.status === 416) {
      throw new Error(
        `PMTiles source replied 416 for range ${offset}-${offset + length - 1}; file may be smaller than the directory claims`,
      );
    }
    if (!res.ok) {
      throw new Error(
        `PMTiles source HTTP ${res.status} for range ${offset}-${offset + length - 1}`,
      );
    }
    const etag = res.headers.get('etag') ?? undefined;
    if (etag && !this.etag) this.etag = etag;
    const buf = await res.arrayBuffer();
    const result: RangeResponse = { data: buf };
    if (etag) result.etag = etag;
    const cc = res.headers.get('cache-control');
    if (cc) result.cacheControl = cc;
    const expires = res.headers.get('expires');
    if (expires) result.expires = expires;
    return result;
  }
}
