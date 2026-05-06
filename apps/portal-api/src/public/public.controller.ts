import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../auth/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { V3FeaturesService } from '../features-v3/v3-features.service.js';

/**
 * Unauthenticated surface area for the portal. Anything here is
 * readable by the internet without a session cookie or bearer
 * token. Keep it narrow: public item metadata, org landing config,
 * public feeds.
 *
 * All responses deliberately carry a lean projection: no shares
 * list, no dependent lookups, nothing that would leak private
 * content through a public endpoint. If in doubt, do not expose it
 * here.
 */
@ApiTags('public')
@Controller('public')
export class PublicController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly v3: V3FeaturesService,
  ) {}

  /**
   * Landing page payload for unauthenticated visitors. Returns:
   *   - resolved org (title, subtitle, hero image URL)
   *   - show-items toggle
   *   - grid of public items (honoring featuredItemIds order) OR
   *     empty array when the toggle is off
   *
   * In single-tenant deployments the `org` query param is optional
   * and resolves to the only organization. Multi-tenant deployments
   * require the slug.
   */
  @Public()
  @Get('landing')
  async landing(@Query('org') orgSlug?: string) {
    const org = orgSlug
      ? await this.prisma.organization.findUnique({ where: { slug: orgSlug } })
      : await this.resolveSingleOrg();
    if (!org) {
      throw new NotFoundException(
        orgSlug
          ? `No organization with slug "${orgSlug}"`
          : 'No organization configured on this portal yet',
      );
    }

    const items = org.landingShowPublicItems
      ? await this.publicItemsFor(org.id, org.landingFeaturedItemIds)
      : [];

    return {
      org: {
        slug: org.slug,
        name: org.name,
        title: org.landingTitle ?? org.name,
        subtitle: org.landingSubtitle ?? null,
        heroImageUrl: org.landingHeroImageUrl ?? null,
        showPublicItems: org.landingShowPublicItems,
      },
      items,
    };
  }

  /**
   * DCAT-lite machine-readable catalog of every public item. Shape
   * follows the W3C Data Catalog Vocabulary loosely: each item
   * becomes a dcat:Dataset with the license, description, tags, and
   * a landing URL back at the portal. Downstream consumers (open-data
   * aggregators, search crawlers, internal tooling) can crawl this to
   * discover what's shareable.
   *
   * The spec-strict DCAT feed (turtle / JSON-LD with full @context)
   * lands in #66: this is the Phase-1 JSON version, which is enough
   * for most aggregators that just want a list of URLs + metadata.
   */
  @Public()
  @Get('catalog.json')
  async catalog(@Req() req: Request, @Query('org') orgSlug?: string) {
    const org = orgSlug
      ? await this.prisma.organization.findUnique({ where: { slug: orgSlug } })
      : await this.resolveSingleOrg();
    if (!org) {
      throw new NotFoundException(
        orgSlug
          ? `No organization with slug "${orgSlug}"`
          : 'No organization configured on this portal yet',
      );
    }

    // Best-effort self URL for the catalog so clients can deref.
    // We honour X-Forwarded-* because portals are typically behind
    // a reverse proxy.
    const proto =
      (req.headers['x-forwarded-proto'] as string | undefined) ??
      req.protocol ??
      'http';
    const host =
      (req.headers['x-forwarded-host'] as string | undefined) ??
      req.headers.host ??
      'localhost';
    const portalBase = `${proto}://${host}`;

    const items = await this.prisma.item.findMany({
      where: {
        orgId: org.id,
        access: 'public',
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        description: true,
        type: true,
        tags: true,
        license: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      '@context': 'https://project-open-data.cio.gov/v1.1/schema/catalog.jsonld',
      conformsTo: 'https://project-open-data.cio.gov/v1.1/schema',
      publisher: { name: org.name },
      dataset: items.map((it) => ({
        '@type': 'dcat:Dataset',
        identifier: it.id,
        title: it.title,
        description: it.description || it.title,
        keyword: it.tags ?? [],
        issued: it.createdAt.toISOString(),
        modified: it.updatedAt.toISOString(),
        landingPage: `${portalBase}/items/${it.id}`,
        // License is optional in v1; absent means "rights reserved".
        // Clients that want a discoverable open-data feed should
        // filter to items with a license set.
        ...(it.license ? { license: it.license } : {}),
        // Rough theme mapping from item type. Not standards-strict
        // but more useful than nothing for downstream facets.
        theme: [it.type],
      })),
    };
  }

  /**
   * Anonymous fetch of a single item by id (#307). Returns the
   * full item only when access='public' and the item isn't trashed;
   * otherwise 404 (deliberately indistinguishable from "no such id"
   * so the existence of a private item never leaks).
   *
   * The shape mirrors authenticated /api/items/:id so the viewer
   * runtime page can swap one for the other based on session
   * presence. Lean projection: shares list is stripped (anonymous
   * callers must not see a roster of who else has access).
   *
   * Anonymous viewer access composes: a publicly shared viewer
   * pulls the map item via this endpoint, then each layer item,
   * then the basemap item. Each must be access='public'
   * independently; we do not transitively grant access. This is
   * the same model AGOL uses (you must publicly share each
   * dependency for an anonymous link to render fully).
   */
  @Public()
  @Get('items/:id')
  async item(@Param('id') id: string) {
    // Anonymous endpoint: malformed input must produce 404, not
    // a 500 leaked from Prisma's UUID parser. Prisma's
    // findFirst({ where: { id } }) throws PrismaClientKnownRequestError
    // when id isn't a valid UUID, which would expose the parser's
    // error message to anonymous callers. UUID-shape gate up front
    // returns the same NotFoundException as a UUID-valid miss so
    // existence (and even input validity) is uniform from the
    // attacker's perspective.
    if (!isUuidShape(id)) throw new NotFoundException('Item not found');
    const item = await this.prisma.item.findFirst({
      where: { id, access: 'public', deletedAt: null },
      include: {
        owner: {
          select: {
            id: true,
            username: true,
            fullName: true,
            avatarUrl: true,
          },
        },
      },
    });
    if (!item) throw new NotFoundException('Item not found');
    return item;
  }

  /**
   * Anonymous list of items, intended for the viewer runtime to
   * pull a list of public basemaps without a session. Limited to
   * type=basemap today; callers asking for any other type get an
   * empty list rather than the full public catalog (the dedicated
   * landing / catalog feeds are the right surface for that).
   */
  @Public()
  @Get('items')
  async items(@Query('type') type?: string) {
    if (type !== 'basemap') return [];
    return this.prisma.item.findMany({
      where: { type: 'basemap', access: 'public', deletedAt: null },
      include: {
        owner: {
          select: {
            id: true,
            username: true,
            fullName: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Anonymous feature collection for a layer of a public
   * data_layer item (#307). Mirrors the auth'd
   * /api/items/:id/layers/:layerId/features endpoint but gated to
   * `access='public'` items. Used by the viewer runtime when no
   * session is present.
   *
   * Supports the same bbox / at filters the auth'd path supports.
   * Per-share geographic restrictions (geoLimit) and rowScope are
   * not in play here -- those concepts only exist for authenticated
   * shares. Layer-level boundary clip would be a future addition
   * if a public-shared map needs it.
   */
  @Public()
  @Get('items/:id/layers/:layerId/features')
  async layerFeatures(
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Query('bbox') bbox?: string,
    @Query('at') at?: string,
  ) {
    if (!isUuidShape(itemId)) throw new NotFoundException('Item not found');
    const item = await this.prisma.item.findFirst({
      where: {
        id: itemId,
        type: 'data_layer',
        access: 'public',
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!item) throw new NotFoundException('Item not found');
    const opts: { bbox?: [number, number, number, number]; at?: string } = {};
    if (bbox) {
      const parts = bbox.split(',').map(Number);
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
        const [w, s, e, n] = parts as [number, number, number, number];
        opts.bbox = [w, s, e, n];
      }
    }
    if (at) opts.at = at;
    return this.v3.listFeatures(itemId, layerId, opts);
  }

  /** Alias of /features under the same naming the auth'd v3
   *  controller exposes. Some callers ask for /geojson, others for
   *  /features; both return the same FeatureCollection. */
  @Public()
  @Get('items/:id/layers/:layerId/geojson')
  async layerGeojson(
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Query('bbox') bbox?: string,
    @Query('at') at?: string,
  ) {
    return this.layerFeatures(itemId, layerId, bbox, at);
  }

  /**
   * Resolve the org for single-tenant portals where the query param
   * is unnecessary. Orders by createdAt so the original seed wins;
   * additional orgs (if any) can still be reached by explicit slug.
   */
  private async resolveSingleOrg() {
    const orgs = await this.prisma.organization.findMany({
      orderBy: { createdAt: 'asc' },
      take: 1,
    });
    return orgs[0] ?? null;
  }

  /**
   * Public items in the org, featured ones first. Lean projection
   * stripped of anything that would leak share lists or tag clouds
   * an admin didn't mean to publish.
   */
  private async publicItemsFor(orgId: string, featuredIds: string[]) {
    const all = await this.prisma.item.findMany({
      where: {
        orgId,
        access: 'public',
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        description: true,
        type: true,
        thumbnailUrl: true,
        updatedAt: true,
        tags: true,
        // Include the data payload so the landing tile can route a
        // templated web_app (editor / viewer) straight to its
        // runtime URL. Without `data`, getItemHref / isViewerItem
        // can't read the `template` discriminator and falls through
        // to /items/:id, which middleware then redirects to sign-in
        // for anonymous visitors. The payload is already public-by-
        // construction (we only emit access='public' rows) and the
        // data shape across the supported types is small.
        data: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (featuredIds.length === 0) return all;

    // Featured = strict filter (matches AGOL's "featured group" UX):
    // when the admin curates a list, the landing shows ONLY those
    // items, in the admin's chosen order. Items no longer public
    // (or moved to trash) drop out silently. If the admin wants the
    // full public catalog they leave the featured list empty, which
    // falls through to the "all public items, newest first" branch
    // above. Previously this method appended the non-featured public
    // items after the featured set, which made the curated list
    // feel like a sort instead of a filter.
    const byId = new Map(all.map((i) => [i.id, i]));
    return featuredIds
      .map((id) => byId.get(id))
      .filter((i): i is NonNullable<typeof i> => !!i);
  }
}

/**
 * Cheap UUID-shape gate for anonymous endpoints. Returns true if
 * the input matches the canonical 8-4-4-4-12 hex pattern (any
 * version). We don't validate the version bits because Prisma
 * will accept anything that parses as a UUID; this gate is a
 * 500-to-404 safety net, not a correctness check. Used by
 * PublicController and PublicProxyController so a stray
 * non-UUID path segment from a crawler or typo returns a clean
 * 404 instead of leaking Prisma's parser error message.
 */
export function isUuidShape(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id,
  );
}
