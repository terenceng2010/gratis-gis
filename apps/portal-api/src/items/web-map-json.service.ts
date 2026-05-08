// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Item } from '@prisma/client';
import {
  type EsriBaseMap,
  type EsriOperationalLayer,
  type EsriWebMap,
  type Lens,
  type LensView,
  lensesToWebMapJson,
  operationalLayerForLens,
} from '@gratis-gis/engine';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Build an Esri WebMapJSON document from a portal `map` item.
 *
 * Walks `MapData.layers[]` and produces one operationalLayer per
 * renderable layer in order. Internal portal sources (data-layer
 * sublayers, derived layers) ride through the engine's Lens type
 * + `lensesToWebMapJson` converter. External sources
 * (arcgis-rest, geojson-url) emit operationalLayers directly
 * since they aren't engine-managed and don't have an internal
 * scope.
 *
 * The basemap reference on the map item is resolved to its
 * basemap item; the resulting tileUrl + attribution flow into the
 * WebMap's BaseMap.baseMapLayers[]. If the basemap item is missing
 * or has no tileUrl, the converter falls back to the seeded
 * `positron` basemap in the same org so the output document
 * stays renderable in third-party clients.
 *
 * The map's saved camera (center / zoom / bearing / pitch) becomes
 * `initialState.viewpoint`. A map without saved camera state omits
 * initialState; clients fall back to their default extent.
 *
 * Authorization is gated upstream: the caller (the controller)
 * runs canRead on the map item before invoking this service.
 * Per-layer ACL on referenced data_layer items is NOT re-checked
 * here -- the WebMap is a static snapshot of "what this map item
 * declares," not a per-recipient view. A user who can read the
 * map but not a referenced data_layer will get a WebMap with the
 * layer URL in it, and the URL itself will 401/403 at fetch time.
 * Mirrors the existing `/items/:id/geojson` semantics.
 */
@Injectable()
export class WebMapJsonService {
  constructor(private readonly prisma: PrismaService) {}

  async buildForMap(args: {
    map: Item;
    /**
     * Absolute URL prefix the converter uses when emitting
     * portal-internal lens URLs (e.g. `https://portal.example.org`).
     * Pulled from the request host so a portal that lives behind a
     * load balancer or a custom domain emits the right links
     * without hardcoding an env var.
     */
    portalBaseUrl: string;
  }): Promise<EsriWebMap> {
    const { map, portalBaseUrl } = args;
    if (map.type !== 'map') {
      throw new NotFoundException(
        'web-map.json is only available for map items',
      );
    }
    const data = map.data as MapDataShape | null;
    const layers = Array.isArray(data?.layers) ? (data.layers ?? []) : [];

    // Resolve the basemap once. Falls back to a static OSM tile URL
    // if the map's basemap reference is empty or unresolvable; that
    // way the WebMap still renders in AGO even if the org has
    // dropped its basemap items.
    const basemap = await this.resolveBasemap(map);

    // Walk each MapLayer once, classifying it as either a Lens (we
    // build one and run it through the converter) or a direct
    // emit (arcgis-rest etc., bypasses Lens). Group layers and
    // unsupported sources are skipped silently; clients see only
    // what they can render.
    const lenses: Lens[] = [];
    const directLayers: EsriOperationalLayer[] = [];
    for (const layer of layers) {
      if (!layer.visible) continue;
      const source = layer.source;
      if (!source) continue;
      if (source.kind === 'data-layer') {
        const lens = lensFromDataLayerSource(layer, source);
        if (lens) lenses.push(lens);
      } else if (source.kind === 'arcgis-rest') {
        const direct = operationalLayerFromArcgisRest(layer, source);
        if (direct) directLayers.push(direct);
      } else if (source.kind === 'geojson-url') {
        directLayers.push(operationalLayerFromGeoJsonUrl(layer, source));
      }
      // geojson-inline and group are not emitted.
    }

    const view = lensViewFromMapData(data);
    const ctx = {
      lensUrlPrefix: `${portalBaseUrl.replace(/\/$/, '')}/api/lenses`,
      basemap,
    };
    const wm = lensesToWebMapJson({ lenses, ...(view ? { view } : {}) }, ctx);

    // Append directLayers (arcgis-rest / geojson-url) AFTER the
    // lens-shaped layers. This keeps layer ordering stable: portal
    // layers stack above external layers in MapLibre on the portal
    // side, so the WebMap output mirrors that. Reorder upstream
    // first if AGO ordering ever has to differ.
    if (directLayers.length > 0) {
      wm.operationalLayers = [
        ...(wm.operationalLayers ?? []),
        ...directLayers,
      ];
    }
    return wm;
  }

  /**
   * Resolve the map's basemap reference to a tileUrl + attribution.
   * Falls back to the org's seeded `positron` basemap, then to a
   * static OSM URL so the output is always renderable.
   */
  private async resolveBasemap(map: Item): Promise<{
    id: string;
    title: string;
    tileUrl: string;
    attribution?: string;
  }> {
    const data = map.data as MapDataShape | null;
    const ref = typeof data?.basemap === 'string' ? data.basemap : '';
    if (ref) {
      const item = await this.prisma.item.findUnique({
        where: { id: ref },
        select: { id: true, title: true, data: true, deletedAt: true, type: true },
      });
      if (
        item &&
        item.type === 'basemap' &&
        item.deletedAt === null
      ) {
        const bm = item.data as BasemapDataShape | null;
        if (typeof bm?.tileUrl === 'string' && bm.tileUrl.length > 0) {
          return {
            id: item.id,
            title: item.title || 'Basemap',
            tileUrl: bm.tileUrl,
            ...(typeof bm.attribution === 'string' && bm.attribution.length > 0
              ? { attribution: bm.attribution }
              : {}),
          };
        }
      }
    }
    // Fallback: org's seeded positron, then any seeded basemap.
    const seeded = await this.prisma.item.findFirst({
      where: { orgId: map.orgId, type: 'basemap', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, title: true, data: true },
    });
    if (seeded) {
      const bm = seeded.data as BasemapDataShape | null;
      if (typeof bm?.tileUrl === 'string' && bm.tileUrl.length > 0) {
        return {
          id: seeded.id,
          title: seeded.title || 'Basemap',
          tileUrl: bm.tileUrl,
          ...(typeof bm.attribution === 'string' && bm.attribution.length > 0
            ? { attribution: bm.attribution }
            : {}),
        };
      }
    }
    // Last resort. A hardcoded OSM raster keeps the WebMap valid
    // when the org has no basemap items at all.
    return {
      id: 'fallback-osm',
      title: 'OpenStreetMap',
      tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '(c) OpenStreetMap contributors',
    };
  }
}

// ---------------------------------------------------------------------------
// MapData -> Lens / direct-layer translators. These operate on the
// MapLayer wire shape from packages/shared-types/src/map.ts. They
// stay private so the wire shape doesn't escape this module.
// ---------------------------------------------------------------------------

function lensFromDataLayerSource(
  layer: MapLayerShape,
  source: { kind: 'data-layer'; itemId: string; layerKey?: string },
): Lens | null {
  // Build the engine scope. v3 multi-layer items have a layerKey;
  // v2/v1 single-table items omit it and we use the conventional
  // 'default' layer id (matching what
  // DerivedLayersService.validateAndEnrich does for v2 sources).
  const layerKey = source.layerKey ?? 'default';
  const scope = `data_layer:${source.itemId}:${layerKey}`;
  return {
    id: layer.id,
    name: layer.title || 'Layer',
    query: { scopes: [scope] },
    render: { kind: 'geojson' },
  };
}

function operationalLayerFromArcgisRest(
  layer: MapLayerShape,
  source: {
    kind: 'arcgis-rest';
    url: string;
    layerId: number;
    serviceType: 'MapServer' | 'FeatureServer';
  },
): EsriOperationalLayer | null {
  // Esri WebMap consumers can fetch FeatureServer / MapServer URLs
  // directly. We emit the URL with the layer id appended (the
  // convention for both service types).
  const trimmed = source.url.replace(/\/$/, '');
  return {
    id: layer.id,
    title: layer.title || 'Layer',
    url: `${trimmed}/${source.layerId}`,
    layerType: 'ArcGISFeatureLayer',
    visibility: layer.visible !== false,
    opacity: typeof layer.opacity === 'number' ? layer.opacity : 1,
  };
}

function operationalLayerFromGeoJsonUrl(
  layer: MapLayerShape,
  source: { kind: 'geojson-url'; url: string },
): EsriOperationalLayer {
  // Esri's WebMap spec doesn't have a first-class GeoJSON layer
  // type; clients that don't know about it fall through to the
  // generic url + layerType pattern. We label as ArcGISFeatureLayer
  // since a GeoJSON file conforms close enough to the feature-
  // layer wire shape that AGO can render it; richer fidelity is
  // a future-spec concern.
  return {
    id: layer.id,
    title: layer.title || 'Layer',
    url: source.url,
    layerType: 'ArcGISFeatureLayer',
    visibility: layer.visible !== false,
    opacity: typeof layer.opacity === 'number' ? layer.opacity : 1,
  };
}

function lensViewFromMapData(data: MapDataShape | null): LensView | undefined {
  if (!data) return undefined;
  const center = Array.isArray(data.center) ? data.center : null;
  if (
    !center ||
    center.length !== 2 ||
    typeof center[0] !== 'number' ||
    typeof center[1] !== 'number'
  ) {
    return undefined;
  }
  const zoom = typeof data.zoom === 'number' ? data.zoom : 0;
  const bearing = typeof data.bearing === 'number' ? data.bearing : undefined;
  const pitch = typeof data.pitch === 'number' ? data.pitch : undefined;
  return {
    center: [center[0], center[1]],
    zoom,
    ...(bearing !== undefined && { bearing }),
    ...(pitch !== undefined && { pitch }),
  };
}

// ---------------------------------------------------------------------------
// Loose wire-shape types so the service doesn't pull on the
// portal-web-side @gratis-gis/shared-types declarations. The full
// MapLayer / MapData definitions live in
// packages/shared-types/src/map.ts; we narrow to just the fields
// the converter cares about, which lets a loosely-shaped
// item.data record still drive the converter without a full
// schema validation pass on every call.
// ---------------------------------------------------------------------------

interface MapDataShape {
  basemap?: string;
  center?: number[];
  zoom?: number;
  bearing?: number;
  pitch?: number;
  layers?: MapLayerShape[];
}

interface MapLayerShape {
  id: string;
  title: string;
  visible?: boolean;
  opacity?: number;
  source?:
    | { kind: 'data-layer'; itemId: string; layerKey?: string }
    | {
        kind: 'arcgis-rest';
        url: string;
        layerId: number;
        serviceType: 'MapServer' | 'FeatureServer';
      }
    | { kind: 'geojson-url'; url: string }
    | { kind: 'geojson-inline'; geojson: unknown }
    | { kind: 'group' };
}

interface BasemapDataShape {
  tileUrl?: string;
  attribution?: string;
}

// Re-export the externally visible types so the controller can
// type the response without pulling on @gratis-gis/engine again.
export type { EsriWebMap, EsriBaseMap, EsriOperationalLayer };
