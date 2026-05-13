// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { ItemAccess, ItemType, Prisma, PrincipalType, SharePermission } from '@prisma/client';
import {
  ITEM_TYPES,
  defaultThumbnailDesign,
  getItemTypeLabel,
  renderThumbnailSvg,
  type ThumbnailDesign,
} from '@gratis-gis/shared-types';

import { Logger } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import type { CreateItemInput, UpdateItemInput } from './items.service.js';
import { ItemsService } from './items.service.js';
import { DataSnapshotService } from './data-snapshot.service.js';
import { WebMapJsonService } from './web-map-json.service.js';
import { WebMapJsonImportService } from './web-map-json-import.service.js';
import { SharingService } from './sharing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

class CreateItemDto {
  @IsEnum(ITEM_TYPES) type!: ItemType;
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  // Typed as JSON-compatible at the Prisma layer; validated at runtime by @IsObject.
  @IsObject() data!: Prisma.InputJsonValue;
  @IsOptional() @IsEnum(['private', 'org', 'public']) access?: ItemAccess;
  // Absolute URL minted by StorageService when the user uploads a custom
  // thumbnail during create. Optional; null/omitted falls back to the
  // auto-generated initial badge.
  @IsOptional() @IsString() @MaxLength(2048) thumbnailUrl?: string | null;
  // Open-data license string (SPDX id, URL, or free-form). Null on
  // create means "not recorded"; DCAT consumers treat absence as
  // "rights reserved".
  @IsOptional() @IsString() @MaxLength(500) license?: string | null;
}

class UpdateItemDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsObject() data?: Prisma.InputJsonValue;
  @IsOptional() @IsEnum(['private', 'org', 'public']) access?: ItemAccess;
  // Absolute URL produced by StorageService after the browser PUT completes.
  // Pass null to clear a previously-set thumbnail.
  @IsOptional() @IsString() @MaxLength(2048) thumbnailUrl?: string | null;
  // Open-data license. SPDX id (CC-BY-4.0), URL, or free-form.
  // Pass null to clear a previously-set license.
  @IsOptional() @IsString() @MaxLength(500) license?: string | null;
  // #80: tier-level geo limits. UUID of a geo_boundary item, or null
  // to clear. The read path treats a missing / wrong-typed target
  // as "no clip" so a broken ref cannot widen access; this DTO does
  // not validate the target is actually a geo_boundary -- the read-
  // time dereference is the source of truth.
  @IsOptional() @IsUUID('loose') publicGeoBoundaryId?: string | null;
  @IsOptional() @IsUUID('loose') orgGeoBoundaryId?: string | null;
}

class ReassignOwnerDto {
  @IsUUID('loose') newOwnerId!: string;
  // null explicitly clears / skips the courtesy share for the
  // previous owner; 'view' | 'download' | 'edit' | 'admin' creates / updates one;
  // omitted = no courtesy share created.
  @IsOptional()
  @IsEnum(['view', 'download', 'edit', 'admin'])
  keepPreviousOwnerAccess?: 'view' | 'download' | 'edit' | 'admin' | null;
}

class BulkReassignDto {
  @IsArray() @IsUUID('loose', { each: true }) itemIds!: string[];
  @IsUUID('loose') newOwnerId!: string;
  @IsOptional()
  @IsEnum(['view', 'download', 'edit', 'admin'])
  keepPreviousOwnerAccess?: 'view' | 'download' | 'edit' | 'admin' | null;
}

class WebMapJsonImportDto {
  // The full Esri WebMap JSON document. Validated structurally by
  // the engine's webMapJsonToLenses; we just enforce "an object"
  // here so a stray string body fails fast with a 400.
  @IsObject() webMap!: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
}

class ShareDto {
  @IsEnum(['user', 'group']) principalType!: PrincipalType;
  // 'loose' accepts any 8-4-4-4-12 hex string. Real UUIDs coming from Keycloak
// and Prisma's @default(uuid()) are always v4, but seed fixtures use
// readable all-same-char UUIDs (aaaa..., bbbb...) for debugging that fail
// strict v4 validation. The DB-level FK check is our real integrity
// guarantee via assertPrincipalExists().
@IsUUID('loose') principalId!: string;
  @IsOptional() @IsEnum(['view', 'download', 'edit', 'admin']) permission?: SharePermission;
  /**
   * Inline GeoJSON polygon (EPSG:4326) that clips what this principal
   * can see on the item. Pass `null` to clear. Omit the field to
   * leave the existing limit untouched. Mutually exclusive with
   * `geoBoundaryId` at the service layer.
   */
  @IsOptional() geoLimit?: unknown | null;
  /**
   * UUID of a geo_boundary item whose geometry supplies the clip.
   * Pass `null` to clear; omit to leave untouched. Mutually
   * exclusive with `geoLimit`. Caller is responsible for ensuring
   * the referenced item is a `geo_boundary` and visible to the
   * grantee; the sharing service does not validate at write time
   * but a missing / wrong-typed target is treated as "no clip" at
   * read time so a deleted boundary cannot silently expand access.
   */
  @IsOptional() @IsUUID('loose') geoBoundaryId?: string | null;
  /**
   * Row-level scope for this share (#40). `'all'` (default) means
   * the principal sees every row in the layer; `'own'` narrows to
   * features they themselves created (`created_by = principal.id`).
   * Pairs with geoLimit / geoBoundaryId so a single share can be
   * "edit only your features in your county". Admins / item owner
   * are exempt regardless. Omit to leave existing scope untouched.
   */
  @IsOptional() @IsEnum(['all', 'own']) rowScope?: 'all' | 'own';
  /**
   * Time-bounded share (#84). ISO date string, or null to clear,
   * or omit to leave untouched. After the timestamp the share is
   * filtered out at request time and eventually swept by the
   * housekeeping cron. Past dates are allowed but produce a
   * share that grants nothing -- handy for testing the filter.
   */
  @IsOptional() @IsDateString() expiresAt?: string | null;
}

@ApiTags('items')
@ApiBearerAuth()
@Controller('items')
export class ItemsController {
  private readonly log = new Logger(ItemsController.name);

  /**
   * Per-process throttle for the lastUsageAt stamp on item-detail
   * GET (#99). Mirrors the proxy controller's pattern from #96.
   * 60s window keeps the DB write off the hot path when a busy
   * map page revalidates the item detail many times per minute.
   */
  private readonly lastUsageWrittenAt = new Map<string, number>();
  private static readonly USAGE_THROTTLE_MS = 60_000;

  constructor(
    private readonly items: ItemsService,
    private readonly snapshots: DataSnapshotService,
    private readonly webMapJsonService: WebMapJsonService,
    private readonly webMapJsonImport: WebMapJsonImportService,
    private readonly sharing: SharingService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('mine') mine?: string,
    @Query('type') type?: string,
    @Query('q') q?: string,
    @Query('ownerId') ownerId?: string,
    @Query('bbox') bbox?: string,
    @Query('buffer') buffer?: string,
    @Query('lite') lite?: string,
    @Query('sharedWithGroupId') sharedWithGroupId?: string,
  ) {
    // Build opts without explicit-undefined keys so `exactOptionalPropertyTypes`
    // is satisfied. Passing `{ type: undefined }` is not the same as omitting it.
    const opts: {
      mine?: boolean;
      type?: ItemType | ItemType[];
      q?: string;
      ownerId?: string;
      bbox?: [number, number, number, number];
      bufferKm?: number;
      lite?: boolean;
      sharedWithGroupId?: string;
    } = {};
    if (mine === 'true') opts.mine = true;
    // ?type accepts a single ItemType or a comma-separated list.
    // Multi-type lets callers (e.g. the Add Layer dialog) pull both
    // data_layer and arcgis_service in one round-trip instead of
    // firing two parallel requests that each pay the auth-sync cost.
    // Each token is validated against ITEM_TYPES so a malformed
    // query stays an empty filter (Prisma rejects bad enum values).
    if (type !== undefined) {
      const tokens = type
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const valid = tokens.filter(
        (t): t is ItemType => (ITEM_TYPES as readonly string[]).includes(t),
      );
      if (valid.length === 1) opts.type = valid[0]!;
      else if (valid.length > 1) opts.type = valid;
      // empty / all-invalid: leave opts.type unset; the caller gets the
      // unfiltered list back, which matches the no-?type behaviour.
    }
    if (q !== undefined) opts.q = q;
    if (ownerId !== undefined) opts.ownerId = ownerId;
    if (lite === '1' || lite === 'true') opts.lite = true;
    // sharedWithGroupId (#100): only accept obvious UUID-shaped values.
    // The service layer would error on a malformed group id at query
    // time anyway, but a quick reject here keeps that error surface
    // off the public list endpoint.
    if (
      sharedWithGroupId !== undefined &&
      /^[0-9a-f-]{32,40}$/i.test(sharedWithGroupId)
    ) {
      opts.sharedWithGroupId = sharedWithGroupId;
    }
    if (bbox !== undefined) {
      const parts = bbox.split(',').map(Number);
      if (
        parts.length === 4 &&
        parts.every((n) => Number.isFinite(n))
      ) {
        const [w, s, e, n] = parts as [number, number, number, number];
        opts.bbox = [w, s, e, n];
      }
    }
    if (buffer !== undefined) {
      const km = Number(buffer);
      if (Number.isFinite(km) && km >= 0) opts.bufferKm = km;
    }
    return this.items.list(user, opts);
  }

  // NOTE: /items/trash must be declared before /items/:id so Nest's
  // route matcher doesn't try to treat "trash" as an id parameter.
  @Get('trash')
  listTrash(@CurrentUser() user: AuthUser) {
    return this.items.listTrash(user);
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const item = await this.items.get(user, id);
    // Stamp lastUsageAt on direct item-detail GET (#99). Covers
    // map opens, pick_list browses, dashboard views -- anything
    // that doesn't go through the proxy. Throttled per-process so
    // a busy detail page doesn't write per request, fire-and-
    // forget so a slow write can't tail-latency the response.
    // Internal callers (housekeeping, items.service.* helpers)
    // hit ItemsService.get directly and bypass this stamp, so
    // system reads correctly don't bump the counter.
    const now = Date.now();
    const last = this.lastUsageWrittenAt.get(id) ?? 0;
    if (now - last >= ItemsController.USAGE_THROTTLE_MS) {
      this.lastUsageWrittenAt.set(id, now);
      this.prisma.item
        .update({
          where: { id },
          data: { lastUsageAt: new Date(now) },
        })
        .catch((err) => {
          this.log.warn(
            `lastUsageAt stamp failed for item=${id}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        });
    }
    return item;
  }

  /**
   * Effective permissions for the current user against this item.
   * Surfaces the same canRead / canEdit / canDownload / canAdmin
   * decisions SharingService computes server-side, so client surfaces
   * (editor runtime, map editor, attribute table) can gate write
   * affordances without re-implementing the policy. #81: editor
   * runtime previously hardcoded canEdit to owner-or-admin which
   * silently hid the toolbar for explicit-share recipients; this
   * endpoint is the supported way to ask the question.
   */
  /**
   * #66: per-item auto-thumbnail SVG.  Reads the row's current
   * title + type + thumbnailDesign and emits an inline <svg>
   * payload.  Computed live (not baked) so a renamed item shows
   * the new title immediately with no re-bake.  Falls back to the
   * type-default design when the row predates the design blob.
   *
   * Returns 404 (via items.get) for callers that can't read the
   * underlying item, so private items don't leak existence
   * through their thumbnail URL.
   *
   * Cache-Control is short-lived but allows revalidation: the
   * caller supplies a `?v=<updatedAt-ms>` query param when
   * generating the URL (see synthesizeThumbnailUrl in
   * items.service.ts) which is enough to bust the cache on
   * rename without needing strong ETags.
   */
  @Get(':id/thumbnail.svg')
  async thumbnailSvg(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const item = await this.items.get(user, id);
    const design =
      (item.thumbnailDesign as ThumbnailDesign | null | undefined) ??
      defaultThumbnailDesign(item.type);
    const svg = renderThumbnailSvg({
      title: item.title,
      typeLabel: getItemTypeLabel(item.type),
      design,
    });
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    // 5 min revalidation; the URL has an updatedAt cache-buster so
    // a longer window only helps when the design hasn't changed.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(svg);
  }

  @Get(':id/permissions')
  async permissions(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    // get() throws 404 when the user can't see the item at all, which
    // is the right behavior here -- if you can't read it, the answer
    // to "what can you do with it?" is "nothing" and a 404 keeps the
    // existence of unreachable items invisible.
    const item = await this.items.get(user, id);
    return {
      canRead: this.sharing.canRead(user, item, item.shares ?? []),
      canEdit: this.sharing.canEdit(user, item, item.shares ?? []),
      canDownload: this.sharing.canDownload(user, item, item.shares ?? []),
      canAdmin: this.sharing.canAdmin(user, item),
    };
  }

  /** Items that THIS item references (e.g. feature services powering
   *  the layers of a web map). Pass ?transitive=true to walk further
   *  (a data_collection's map's layers, a map's layers' pick_lists). */
  @Get(':id/dependencies')
  dependencies(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('transitive') transitive?: string,
  ) {
    return this.items.listDependencies(user, id, {
      transitive: transitive === 'true' || transitive === '1',
    });
  }

  /**
   * Resolve a folder's children into the visible item rows. Drops:
   *  - items the caller cannot see (per-item authz)
   *  - items in the trash (deletedAt set)
   *  - dangling references to items that no longer exist
   * Returns the surviving items in the order specified by the folder's
   * childItemIds. See docs/folders.md.
   */
  @Get(':id/folder-contents')
  folderContents(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.items.listFolderContents(user, id);
  }

  /** Items that reference THIS one. Pass ?transitive=true to walk
   *  further (e.g. a layer used by a map used by a dashboard). */
  @Get(':id/dependents')
  dependents(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('transitive') transitive?: string,
  ) {
    return this.items.listDependents(user, id, {
      transitive: transitive === 'true' || transitive === '1',
    });
  }

  /**
   * Cascade-revert candidates (#334). Inverse of #310's
   * cascade-public flow. Returns the transitive dependencies that
   * are currently access='public' and aren't independently required
   * by any other public item -- i.e. the items the caller can
   * safely downgrade alongside making this parent non-public. The
   * client surfaces these in a confirmation dialog before applying
   * the downgrade. Items referenced by another public consumer are
   * silently dropped so the dialog never offers to break that
   * consumer's anonymous render.
   */
  @Get(':id/cascade-revert-candidates')
  cascadeRevertCandidates(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.items.listCascadeRevertCandidates(user, id);
  }

  /**
   * GeoJSON-only view of a data_layer item. Handles both v1 (inline
   * JSON) and v2 (PostGIS) storage transparently.
   *
   * For v2 items, accepts ?bbox=minX,minY,maxX,maxY and ?at=<ISO timestamp>
   * for spatial filtering and point-in-time queries respectively.
   *
   * Visibility goes through the same sharing check as the regular get.
   */
  @Get(':id/geojson')
  async geojson(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('bbox') bbox?: string,
    @Query('at') at?: string,
    @Query('clip') clip?: string,
  ) {
    // Use conditional spread (not `undefined` values) to play nicely
    // with exactOptionalPropertyTypes; the destructure also narrows
    // parts[0..3] from `number | undefined` down to `number`, which
    // is what the service signature needs.
    const opts: {
      bbox?: [number, number, number, number];
      at?: string;
      boundaryClipId?: string;
    } = {};
    if (bbox) {
      const parts = bbox.split(',').map(Number);
      if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
        const [minX, minY, maxX, maxY] = parts as [number, number, number, number];
        opts.bbox = [minX, minY, maxX, maxY];
      }
    }
    if (at) opts.at = at;
    // Layer-level boundary clip (#34). Same semantics as the v3
    // controller's ?clip=: the map author's per-layer content
    // scope. Bypasses per-user authz on the boundary item; missing
    // / wrong-type / no-geometry is treated as no clip.
    if (clip) opts.boundaryClipId = clip;
    return this.items.getGeoJson(user, id, opts);
  }

  /**
   * Esri WebMapJSON view of a `map` item. Lets ArcGIS Pro / AGO /
   * QGIS WebMap importers consume a portal map natively without
   * needing a portal-specific adapter. Walks
   * `MapData.layers[]`, builds a Lens per data-layer source,
   * passes the bag through `lensesToWebMapJson`, and merges in
   * the map's saved camera + basemap reference.
   *
   * Authorization: requires canRead on the map item itself.
   * Per-layer ACL on referenced data_layers is NOT re-checked
   * here (the response is a static reference document, not a
   * data extract). External clients fetching a layer URL still
   * hit the real per-layer auth check.
   */
  @Get(':id/web-map.json')
  async webMapJson(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Headers('host') host?: string,
    @Headers('x-forwarded-host') forwardedHost?: string,
    @Headers('x-forwarded-proto') forwardedProto?: string,
  ) {
    // Resolve the item via the existing items.get gate (canRead +
    // not-trashed + visible-to-user). 404 / 403 the same way the
    // detail page does so the WebMap endpoint can't probe for
    // hidden ids.
    const map = await this.items.get(user, id);
    // Build the absolute portal base URL from the request headers.
    // Behind a load balancer the X-Forwarded-* pair is the source
    // of truth; in dev, fall back to the raw Host header. Default
    // to https since we never serve plaintext in prod.
    const proto = forwardedProto?.split(',')[0]?.trim() || 'https';
    const resolvedHost = forwardedHost?.split(',')[0]?.trim() || host || '';
    const portalBaseUrl = resolvedHost ? `${proto}://${resolvedHost}` : '';
    return this.webMapJsonService.buildForMap({ map, portalBaseUrl });
  }

  /**
   * Import an Esri WebMap JSON document. Reverse direction of
   * `GET /items/:id/web-map.json`. Body: `{ webMap, title?,
   * description? }`. Walks operationalLayers and produces a
   * portal `map` item with one MapLayer per recognisable
   * operationalLayer (FeatureServer / MapServer / GeoJSON URL);
   * unrecognised entries surface in the response `warnings`
   * list. The endpoint is idempotent only by what the caller
   * sends -- it always creates a new map item, never merges with
   * an existing one.
   *
   * The body uses `application/json` and is bounded by the
   * default Nest body-parser limit (~100 KB by default; large
   * WebMaps with hundreds of layers may need a higher cap if
   * they ever land in the wild).
   */
  @Post('web-map-json:import')
  async importWebMapJson(
    @CurrentUser() user: AuthUser,
    @Body() dto: WebMapJsonImportDto,
  ) {
    if (!dto.webMap || typeof dto.webMap !== 'object') {
      throw new BadRequestException(
        'Request body must include a `webMap` object.',
      );
    }
    return this.webMapJsonImport.import({
      user,
      webMap: dto.webMap as unknown as Parameters<
        typeof this.webMapJsonImport.import
      >[0]['webMap'],
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.description !== undefined && { description: dto.description }),
    });
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateItemDto) {
    return this.items.create(user, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateItemDto,
  ) {
    return this.items.update(user, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('cascade') cascade?: string,
  ) {
    // ?cascade=true acknowledges the folder-cascade preview (#156)
    // so the service knows the client has shown the user the list
    // of subfolders that will also be trashed. Any other value is
    // treated as not-set rather than false to keep the contract
    // strict (a stray `?cascade=foo` shouldn't accidentally
    // authorise a cascade).
    const cascadeFlag = cascade === 'true';
    return this.items.remove(user, id, { cascade: cascadeFlag });
  }

  /**
   * Return the cascade-delete preview for a folder (#156). For
   * non-folder items the response is `{ folders: [], unlinkedItemCount: 0 }`
   * so callers can render the same dialog shape uniformly.
   *
   * Callers fetch this before showing the soft-delete confirm
   * dialog so they can list the subfolders that would be trashed
   * alongside the parent. The DELETE call itself returns the same
   * preview as a 409 body if invoked without cascade=true; this
   * separate GET exists so the dialog can preview without needing
   * to fail-and-retry.
   */
  @Get(':id/delete-cascade')
  previewDeleteCascade(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.items.previewFolderDeleteCascade(user, id);
  }

  @Post(':id/restore')
  restore(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.items.restore(user, id);
  }

  /**
   * Permanent delete. Distinct verb+path from soft-delete so a bad client
   * retrying a DELETE can't accidentally skip the trash step.
   */
  @Delete(':id/purge')
  purge(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.items.purge(user, id);
  }

  @Post(':id/share')
  share(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ShareDto,
  ) {
    return this.items.share(user, id, dto);
  }

  @Delete(':id/share')
  unshare(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ShareDto,
  ) {
    return this.items.unshare(user, id, dto);
  }

  @Patch(':id/owner')
  reassignOwner(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReassignOwnerDto,
  ) {
    const patch: {
      newOwnerId: string;
      keepPreviousOwnerAccess?: 'view' | 'download' | 'edit' | 'admin' | null;
    } = { newOwnerId: dto.newOwnerId };
    if (dto.keepPreviousOwnerAccess !== undefined) {
      patch.keepPreviousOwnerAccess = dto.keepPreviousOwnerAccess;
    }
    return this.items.reassignOwner(user, id, patch);
  }

  /**
   * List data-replace snapshots for an item. The payload doesn't
   * include the full data blob (just metadata) so the history
   * panel can render cheaply. Caller must have edit access
   * snapshots are authorship history, not public.
   */
  @Get(':id/snapshots')
  async listSnapshots(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    await this.items.assertCanEdit(user, id);
    return this.snapshots.list(id);
  }

  /**
   * Revert an item's data to a prior snapshot. Captures the current
   * state as a fresh snapshot first, so un-revert is possible for
   * the retention window. Caller must have edit access.
   *
   * The snapshotId must belong to the item in the URL: we don't want
   * /items/A/snapshots/{snap-from-B}/revert to quietly mutate B just
   * because the caller happens to have edit access on A.
   */
  @Post(':id/snapshots/:snapshotId/revert')
  async revertSnapshot(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('snapshotId') snapshotId: string,
  ) {
    await this.items.assertCanEdit(user, id);
    const snap = await this.snapshots.get(snapshotId);
    if (snap.itemId !== id) {
      throw new BadRequestException(
        'Snapshot does not belong to this item',
      );
    }
    return this.snapshots.revert(snapshotId, user.id);
  }

  @Post('bulk/reassign-owner')
  bulkReassign(
    @CurrentUser() user: AuthUser,
    @Body() dto: BulkReassignDto,
  ) {
    const patch: {
      itemIds: string[];
      newOwnerId: string;
      keepPreviousOwnerAccess?: 'view' | 'download' | 'edit' | 'admin' | null;
    } = { itemIds: dto.itemIds, newOwnerId: dto.newOwnerId };
    if (dto.keepPreviousOwnerAccess !== undefined) {
      patch.keepPreviousOwnerAccess = dto.keepPreviousOwnerAccess;
    }
    return this.items.bulkReassignOwner(user, patch);
  }
}
