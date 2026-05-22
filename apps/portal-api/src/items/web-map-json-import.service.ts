// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  type EsriWebMap,
  type Lens,
  type LensView,
  webMapJsonToLenses,
} from '@gratis-gis/engine';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ItemsService } from './items.service.js';

/**
 * Import an Esri WebMap JSON document and create a portal `map`
 * item from it. The reverse direction of
 * `WebMapJsonService.buildForMap` (`GET /items/:id/web-map.json`).
 *
 * The resolver is best-effort:
 *
 *   - Each operationalLayer's URL is matched against the org's
 *     existing arcgis_service items first. If a match is found,
 *     the resulting MapLayer references that item directly via a
 *     `kind: 'arcgis-rest'` source pointed at the same URL.
 *   - Unmatched FeatureServer / MapServer URLs become bare
 *     `kind: 'arcgis-rest'` MapLayers with the URL persisted
 *     verbatim. The user can later re-link them to a portal
 *     arcgis_service item if they create one.
 *   - Plain GeoJSON file URLs (anything ending in `.geojson` or
 *     `.json`) become `kind: 'geojson-url'`.
 *   - Anything else surfaces as a warning and is skipped.
 *
 * Basemap resolution: pulls every basemap item in the calling
 * user's org and matches by tileUrl. No match -> falls back to
 * the empty-string sentinel, which the portal viewer treats as
 * "use the org default."
 *
 * Viewpoint -> MapData: the WebMap's `initialState.viewpoint`
 * envelope center becomes `MapData.center`; the scale is
 * converted back to a MapLibre zoom via
 * `log2(591657550.5 / scale)`. A WebMap without initialState
 * gets a fallback center of [0, 0] / zoom 2 so the resulting
 * map item is renderable.
 *
 * Authorization: the calling user has to have create-item rights
 * (any authenticated user with a `contributor` org role does).
 * Per-layer ACL on referenced arcgis_service items is NOT
 * re-checked here -- the import is a metadata operation; data
 * fetches still go through the per-item gate at fetch time.
 *
 * The service returns the new item id plus a list of warnings
 * the import UI should surface to the user as a dry-run summary.
 */
@Injectable()
export class WebMapJsonImportService {
  private readonly log = new Logger(WebMapJsonImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
  ) {}

  async import(args: {
    user: AuthUser;
    webMap: EsriWebMap;
    /**
     * Optional: title for the new map item. Defaults to the
     * WebMap's authoringApp + "import" suffix, or "Imported web
     * map" if no authoringApp is declared.
     */
    title?: string;
    /**
     * Optional: description for the new map item. Surfaced on the
     * detail page like any user-authored description.
     */
    description?: string;
    /**
     * Optional: sharing scope for the new map item. Defaults to
     * 'private' to preserve the original (pre-AGO-importer)
     * behaviour; callers that want to mirror an upstream
     * sharing scope pass it explicitly.
     */
    access?: 'private' | 'org' | 'public';
    /**
     * Optional: lookup the AGO importer fills with newly-imported
     * data_layers so this converter can resolve a WebMap layer
     * URL like `<serviceUrl>/<n>` into a portal-rooted
     * `{ kind: 'data-layer', itemId, layerKey }` source instead
     * of leaving the layer pointing at AGO. Key is the canonical
     * (normalized, lowercase, no sublayer suffix) service URL;
     * value carries the portal item id and a per-AGO-layer-id
     * map onto the data_layer's sublayer keys.
     *
     * When unset (every caller pre-AGO-importer-phase-6) the
     * converter falls back to the arcgis_service / geojson-url
     * paths, matching the historical behaviour.
     */
    agoDataLayerLookup?: Map<
      string,
      {
        itemId: string;
        agoLayerIdToSublayerKey: Record<number, string>;
      }
    >;
  }): Promise<{
    itemId: string;
    warnings: string[];
    layerCount: number;
    skippedLayerCount: number;
    /** Count of operational-layer URLs that matched a newly-imported
     *  portal data_layer (via agoDataLayerLookup) and were rerouted
     *  to a portal-rooted source. Surfaces in the import report so
     *  the operator can see the "no longer pointing at AGO" effect. */
    remappedToDataLayerCount: number;
  }> {
    const { user, webMap } = args;

    // Engine-level parse + per-layer translation. Throws on
    // missing version or no usable operationalLayers.
    let parsed: ReturnType<typeof webMapJsonToLenses>;
    try {
      parsed = webMapJsonToLenses(webMap);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Invalid Esri WebMap JSON',
      );
    }
    const warnings = [...parsed.warnings];

    // Pre-load the org's arcgis_service items so we can match
    // FeatureServer / MapServer URLs against them in one pass.
    const arcgisItems = await this.prisma.item.findMany({
      where: {
        orgId: user.orgId,
        type: 'arcgis_service',
        deletedAt: null,
      },
      select: { id: true, data: true },
    });
    const arcgisByUrl = new Map<string, string>();
    for (const it of arcgisItems) {
      const url = (it.data as { url?: unknown } | null)?.url;
      if (typeof url === 'string' && url.length > 0) {
        // Store both the exact URL and the URL with the trailing
        // /<layerId> stripped so a match against either survives.
        arcgisByUrl.set(url, it.id);
        const stripped = url.replace(/\/\d+\/?$/, '');
        if (stripped !== url) arcgisByUrl.set(stripped, it.id);
      }
    }

    // Walk every translated lens and build the corresponding
    // MapLayer record. The lens carries the original URL stashed
    // under query.sourceUrl; we never persist the lens itself
    // since v1 doesn't have a Lens registry.
    const layers: MapLayerOut[] = [];
    let skipped = 0;
    let remappedToDataLayerCount = 0;
    for (const lens of parsed.lenses) {
      const sourceUrl = (lens.query as { sourceUrl?: string }).sourceUrl;
      if (!sourceUrl) {
        skipped += 1;
        warnings.push(
          `Lens "${lens.name}" has no source URL; skipped.`,
        );
        continue;
      }
      // First chance: if the AGO importer just brought this
      // FeatureServer in as a portal data_layer, point the new map
      // at the portal item directly. Without this, the map would
      // stay tethered to AGO even after the data is sitting in
      // our PostGIS.
      const dataLayerSource = args.agoDataLayerLookup
        ? matchAgoDataLayerSource(sourceUrl, args.agoDataLayerLookup)
        : null;
      if (dataLayerSource) {
        layers.push(buildMapLayer({ lens, source: dataLayerSource }));
        remappedToDataLayerCount += 1;
        continue;
      }
      const mapped = mapSourceFromUrl({
        url: sourceUrl,
        renderKind: lens.render.kind,
        arcgisByUrl,
      });
      if (!mapped) {
        skipped += 1;
        warnings.push(
          `Layer "${lens.name}" URL was unrecognised (${sourceUrl}); skipped.`,
        );
        continue;
      }
      layers.push(buildMapLayer({ lens, source: mapped }));
    }

    if (layers.length === 0) {
      throw new BadRequestException(
        'WebMap import produced zero usable layers. ' +
          'Check that the source has at least one ArcGISFeatureLayer or VectorTileLayer.',
      );
    }

    // Resolve the basemap to a portal item by tileUrl match. No
    // match -> empty string sentinel; the viewer falls back to
    // the org default at render time.
    const basemap = await this.resolveBasemap(user, webMap);

    // Build the canonical MapData payload. center / zoom come
    // from the WebMap's initialState if present; otherwise we
    // emit a defensible default so the resulting item renders.
    const view = parsed.view;
    const mapData = {
      version: 1 as const,
      basemap,
      center: view?.center ?? [0, 0],
      zoom: view?.zoom ?? 2,
      bearing: view?.bearing ?? 0,
      pitch: view?.pitch ?? 0,
      layers,
      search: { enabled: true, geocoding: true },
    };

    const title =
      (args.title?.trim() || guessTitle(webMap)) || 'Imported web map';

    const created = await this.items.create(user, {
      type: 'map',
      title,
      ...(args.description !== undefined && { description: args.description }),
      data: mapData as unknown as Prisma.InputJsonValue,
      access: args.access ?? 'private',
    });

    this.log.log(
      `Imported WebMap as map item ${created.id} for user ${user.id} ` +
        `(${layers.length} layer(s), ${skipped} skipped, ${warnings.length} warning(s))`,
    );
    return {
      itemId: created.id,
      warnings,
      layerCount: layers.length,
      skippedLayerCount: skipped,
      remappedToDataLayerCount,
    };
  }

  /**
   * Match the WebMap's basemap tileUrl against the calling user's
   * org's basemap items. Returns the matching item id, or empty
   * string if nothing matches (the viewer treats empty as
   * "use the org default seeded basemap").
   */
  private async resolveBasemap(
    user: AuthUser,
    webMap: EsriWebMap,
  ): Promise<string> {
    const tileUrl = webMap.baseMap?.baseMapLayers?.[0]?.url;
    if (typeof tileUrl !== 'string' || tileUrl.length === 0) return '';
    const candidates = await this.prisma.item.findMany({
      where: { orgId: user.orgId, type: 'basemap', deletedAt: null },
      select: { id: true, data: true },
    });
    for (const c of candidates) {
      const url = (c.data as { tileUrl?: unknown } | null)?.tileUrl;
      if (typeof url === 'string' && url === tileUrl) return c.id;
    }
    return '';
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ResolvedSource {
  source: MapLayerOut['source'];
  /**
   * Optional warning copy the caller surfaces if this resolution
   * involved a partial match (e.g. URL pointed at a portal item
   * that's been trashed).
   */
  warning?: string;
}

/**
 * Translate an Esri operationalLayer URL into a portal MapLayer
 * source. Returns undefined for URLs we can't classify; callers
 * surface that as a per-layer warning.
 *
 * URL patterns recognised:
 *   - .../FeatureServer/<n>      -> arcgis-rest, FeatureServer
 *   - .../MapServer/<n>          -> arcgis-rest, MapServer
 *   - .../{z}/{x}/{y}.pbf        -> arcgis-rest (vector tiles served
 *                                   live; v1 maps as a feature layer
 *                                   pointer for now)
 *   - *.geojson / *.json         -> geojson-url
 */
/**
 * Resolve an Esri operationalLayer URL against the AGO importer's
 * just-imported portal data_layers (#54/#55/#56 wave). The AGO
 * importer fills the lookup as it converts hosted Feature
 * Services into portal data_layer items; for every WebMap layer
 * URL of the form `<serviceUrl>/<agoLayerId>` we check whether
 * the service was one we just imported and, if so, point the new
 * MapLayer at the portal item directly.
 *
 * Returns null when:
 *   - the URL doesn't match the FeatureServer/MapServer + layer
 *     id shape (e.g. plain GeoJSON URLs, vector tile URLs)
 *   - the service URL isn't in the lookup (external service)
 *   - the service was imported but the specific AGO layer id
 *     wasn't (e.g. operator excluded one sublayer of a multi-
 *     layer service in the preview)
 *
 * The caller falls back to the legacy arcgis_service / geojson
 * paths when null is returned.
 */
function matchAgoDataLayerSource(
  sourceUrl: string,
  lookup: Map<
    string,
    { itemId: string; agoLayerIdToSublayerKey: Record<number, string> }
  >,
): MapLayerOut['source'] | null {
  const url = sourceUrl.trim();
  if (!url) return null;
  // Match the same FeatureServer/MapServer + integer sublayer
  // shape mapSourceFromUrl uses, so the two paths stay in sync.
  const m = url.match(/^(.*\/(?:FeatureServer|MapServer))\/(\d+)\/?$/i);
  if (!m) return null;
  const serviceRoot = m[1] as string;
  const agoLayerId = Number.parseInt(m[2] as string, 10);
  // Normalize the service root the same way the AGO importer
  // did when populating the lookup (lowercase, no trailing
  // sublayer / slash / query string). Inlined rather than
  // imported from import-ago/ to avoid a backwards module dep.
  const canonical = serviceRoot.replace(/\/\d+\/*(?:\?.*)?$/, '').toLowerCase();
  const hit = lookup.get(canonical) ?? lookup.get(serviceRoot.toLowerCase());
  if (!hit) return null;
  const layerKey = hit.agoLayerIdToSublayerKey[agoLayerId];
  if (!layerKey) return null;
  return {
    kind: 'data-layer',
    itemId: hit.itemId,
    layerKey,
  };
}

function mapSourceFromUrl(args: {
  url: string;
  renderKind: 'geojson' | 'mvt' | 'geojson_table' | 'scalar_json';
  arcgisByUrl: Map<string, string>;
}): MapLayerOut['source'] | null {
  const url = args.url.trim();
  if (url.length === 0) return null;

  // FeatureServer / MapServer with a layer-id suffix: parse it.
  const featureServer = url.match(/^(.*\/FeatureServer)\/(\d+)\/?$/i);
  if (featureServer) {
    const matchedItemId = args.arcgisByUrl.get(url);
    return {
      kind: 'arcgis-rest',
      url: featureServer[1] as string,
      layerId: Number.parseInt(featureServer[2] as string, 10),
      serviceType: 'FeatureServer',
      ...(matchedItemId !== undefined && { sourceItemId: matchedItemId }),
    };
  }
  const mapServer = url.match(/^(.*\/MapServer)\/(\d+)\/?$/i);
  if (mapServer) {
    const matchedItemId = args.arcgisByUrl.get(url);
    return {
      kind: 'arcgis-rest',
      url: mapServer[1] as string,
      layerId: Number.parseInt(mapServer[2] as string, 10),
      serviceType: 'MapServer',
      ...(matchedItemId !== undefined && { sourceItemId: matchedItemId }),
    };
  }

  // Plain GeoJSON URL.
  if (/\.(geo)?json(\?|$)/i.test(url)) {
    return { kind: 'geojson-url', url };
  }

  // Vector-tile URL pattern. Defer to a generic arcgis-rest
  // fall-through so something renders; richer support is a
  // future feature.
  if (/\{z\}\/\{[xy]\}\/\{[xy]\}\.pbf/i.test(url)) {
    return null; // unsupported in v1, surface as warning
  }

  return null;
}

function buildMapLayer(args: {
  lens: Omit<Lens, 'id'>;
  source: MapLayerOut['source'];
}): MapLayerOut {
  // Stable layer id keeps round-trip metadata predictable. UUID
  // is overkill but we don't have a better counter handy.
  const id = `imported-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    title: args.lens.name,
    visible: true,
    opacity: 1,
    source: args.source,
    style: defaultLayerStyle(),
    renderer: { kind: 'simple' },
    popup: { enabled: true, fields: [] },
    interactions: { hoverEffect: false, clickToZoom: false },
    labels: { enabled: false, expression: '' },
    search: { enabled: false, fields: [] },
    filter: null,
    scale: {
      minZoom: null,
      maxZoom: null,
      scaleWithZoom: true,
      labelsMinZoom: null,
      labelsMaxZoom: null,
    },
    access: { policy: 'inherit', entries: [] },
  };
}

function defaultLayerStyle(): MapLayerOut['style'] {
  return {
    point: {
      color: '#3b82f6',
      radius: 6,
      strokeColor: '#1e3a8a',
      strokeWidth: 1,
      symbol: 'circle',
      iconName: '',
      iconSize: 1,
      iconTint: false,
    },
    line: { color: '#3b82f6', width: 2 },
    polygon: {
      fillColor: '#93c5fd',
      fillOpacity: 0.4,
      strokeColor: '#1e3a8a',
      strokeWidth: 1,
    },
  };
}

function guessTitle(webMap: EsriWebMap): string {
  if (webMap.authoringApp && webMap.authoringApp !== 'GratisGIS') {
    return `${webMap.authoringApp} import`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Loose MapLayer / source shape. Mirrors what the shared-types
// MapData definition expects on the wire; kept narrow so the
// service compiles without pulling on a full MapData import.
// ---------------------------------------------------------------------------

interface MapLayerOut {
  id: string;
  title: string;
  visible: boolean;
  opacity: number;
  source:
    | { kind: 'data-layer'; itemId: string; layerKey?: string }
    | {
        kind: 'arcgis-rest';
        url: string;
        layerId: number;
        serviceType: 'MapServer' | 'FeatureServer';
        sourceItemId?: string;
      }
    | { kind: 'geojson-url'; url: string };
  style: {
    point: {
      color: string;
      radius: number;
      strokeColor: string;
      strokeWidth: number;
      symbol: 'circle' | 'icon';
      iconName: string;
      iconSize: number;
      iconTint: boolean;
    };
    line: { color: string; width: number };
    polygon: {
      fillColor: string;
      fillOpacity: number;
      strokeColor: string;
      strokeWidth: number;
    };
  };
  renderer: { kind: 'simple' };
  popup: { enabled: boolean; fields: string[] };
  interactions: { hoverEffect: boolean; clickToZoom: boolean };
  labels: { enabled: boolean; expression: string };
  search: { enabled: boolean; fields: string[] };
  filter: null;
  scale: {
    minZoom: number | null;
    maxZoom: number | null;
    scaleWithZoom: boolean;
    labelsMinZoom: number | null;
    labelsMaxZoom: number | null;
  };
  access: { policy: 'inherit'; entries: [] };
}

// `LensView` is referenced by the engine; re-export so the
// controller signature can quote it without a separate import.
export type { LensView };
