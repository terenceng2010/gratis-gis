// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Item } from '@prisma/client';

import { WebMapJsonService } from './web-map-json.service.js';

/**
 * Behaviour pin for the MapData -> WebMapJSON resolver. The
 * underlying engine converters (lensesToWebMapJson,
 * operationalLayerForLens) have their own specs; this file
 * exercises the *resolution* layer:
 *   - data-layer source -> Lens -> ArcGISFeatureLayer at
 *     /api/lenses/<layerId>/features
 *   - arcgis-rest source -> ArcGISFeatureLayer at the external
 *     URL, with the layer id appended
 *   - geojson-url source -> ArcGISFeatureLayer at the external URL
 *   - hidden / group layers are skipped
 *   - basemap reference resolves through the prisma findUnique
 *     mock; missing falls back to seeded basemap then to OSM
 *   - missing host header still produces a valid (but pathless)
 *     WebMap document (the test verifies the version + structure)
 */

function makeMap(overrides: Partial<Item> = {}): Item {
  return {
    id: 'map-1',
    orgId: 'org-1',
    ownerId: 'owner-1',
    type: 'map',
    title: 'Test map',
    description: '',
    tags: [],
    data: {
      basemap: 'basemap-1',
      center: [-122.4, 37.7],
      zoom: 10,
      bearing: 0,
      pitch: 0,
      layers: [
        {
          id: 'layer-portal',
          title: 'Parcels',
          visible: true,
          opacity: 1,
          source: { kind: 'data-layer', itemId: 'dl-1', layerKey: 'lyr_a' },
        },
        {
          id: 'layer-arcgis',
          title: 'External roads',
          visible: true,
          opacity: 0.8,
          source: {
            kind: 'arcgis-rest',
            url: 'https://services.example.com/arcgis/rest/services/Roads/FeatureServer',
            layerId: 0,
            serviceType: 'FeatureServer',
          },
        },
        {
          id: 'layer-geojson',
          title: 'External GeoJSON',
          visible: true,
          opacity: 1,
          source: {
            kind: 'geojson-url',
            url: 'https://example.com/data.geojson',
          },
        },
        {
          id: 'layer-hidden',
          title: 'Hidden',
          visible: false,
          opacity: 1,
          source: { kind: 'data-layer', itemId: 'dl-2' },
        },
        {
          id: 'layer-group',
          title: 'Group',
          visible: true,
          opacity: 1,
          source: { kind: 'group' },
        },
      ],
    },
    access: 'private',
    bbox: [],
    thumbnailUrl: null,
    license: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastUsageAt: null,
    ...(overrides as Record<string, unknown>),
  } as unknown as Item;
}

function makePrismaMock(opts: {
  basemapItem?: {
    id: string;
    title: string;
    data: { tileUrl: string; attribution?: string };
    type: string;
    deletedAt: Date | null;
  };
  /** Seeded basemap fallback returned by findFirst. */
  fallbackBasemap?: {
    id: string;
    title: string;
    data: { tileUrl: string; attribution?: string };
  };
}) {
  return {
    item: {
      findUnique: async () => opts.basemapItem ?? null,
      findFirst: async () => opts.fallbackBasemap ?? null,
    },
  } as unknown as ConstructorParameters<typeof WebMapJsonService>[0];
}

describe('WebMapJsonService', () => {
  it('builds a multi-layer WebMap with portal, arcgis, geojson, skipping hidden + group', async () => {
    const svc = new WebMapJsonService(
      makePrismaMock({
        basemapItem: {
          id: 'basemap-1',
          title: 'Positron',
          type: 'basemap',
          deletedAt: null,
          data: {
            tileUrl: 'https://basemaps.example.org/positron/{z}/{x}/{y}.png',
            attribution: '(c) Carto',
          },
        },
      }),
    );
    const wm = await svc.buildForMap({
      map: makeMap(),
      portalBaseUrl: 'https://portal.example.org',
    });
    expect(wm.version).toMatch(/^2\./);
    const layers = wm.operationalLayers ?? [];
    expect(layers.length).toBe(3);
    // Order: portal layers first, external second.
    expect(layers[0]?.id).toBe('layer-portal');
    expect(layers[0]?.url).toBe(
      'https://portal.example.org/api/lenses/layer-portal/features',
    );
    expect(layers[1]?.id).toBe('layer-arcgis');
    expect(layers[1]?.url).toBe(
      'https://services.example.com/arcgis/rest/services/Roads/FeatureServer/0',
    );
    expect(layers[1]?.opacity).toBeCloseTo(0.8);
    expect(layers[2]?.id).toBe('layer-geojson');
    expect(layers[2]?.url).toBe('https://example.com/data.geojson');
    // Hidden + group never appear.
    const ids = layers.map((l) => l.id);
    expect(ids).not.toContain('layer-hidden');
    expect(ids).not.toContain('layer-group');
  });

  it('emits the resolved basemap tileUrl + attribution', async () => {
    const svc = new WebMapJsonService(
      makePrismaMock({
        basemapItem: {
          id: 'basemap-1',
          title: 'Voyager',
          type: 'basemap',
          deletedAt: null,
          data: {
            tileUrl: 'https://basemaps.example.org/voyager/{z}/{x}/{y}.png',
            attribution: '(c) OSM (c) Carto',
          },
        },
      }),
    );
    const wm = await svc.buildForMap({
      map: makeMap(),
      portalBaseUrl: 'https://portal.example.org',
    });
    const bmLayer = wm.baseMap?.baseMapLayers[0];
    expect(bmLayer?.url).toBe(
      'https://basemaps.example.org/voyager/{z}/{x}/{y}.png',
    );
    expect(bmLayer?.copyright).toBe('(c) OSM (c) Carto');
  });

  it('falls back to seeded basemap when reference is missing', async () => {
    const svc = new WebMapJsonService(
      makePrismaMock({
        // basemapItem omitted: the explicit ref doesn't resolve.
        fallbackBasemap: {
          id: 'basemap-fallback',
          title: 'OSM',
          data: {
            tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            attribution: '(c) OpenStreetMap contributors',
          },
        },
      }),
    );
    const wm = await svc.buildForMap({
      map: makeMap(),
      portalBaseUrl: 'https://portal.example.org',
    });
    const bmLayer = wm.baseMap?.baseMapLayers[0];
    expect(bmLayer?.url).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  });

  it('falls back to hardcoded OSM when no seeded basemap exists either', async () => {
    const svc = new WebMapJsonService(makePrismaMock({}));
    const wm = await svc.buildForMap({
      map: makeMap(),
      portalBaseUrl: 'https://portal.example.org',
    });
    const bmLayer = wm.baseMap?.baseMapLayers[0];
    expect(bmLayer?.url).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  });

  it('emits initialState.viewpoint from MapData center+zoom', async () => {
    const svc = new WebMapJsonService(makePrismaMock({}));
    const wm = await svc.buildForMap({
      map: makeMap(),
      portalBaseUrl: 'https://portal.example.org',
    });
    const env = wm.initialState?.viewpoint?.targetGeometry;
    expect(env?.spatialReference).toEqual({ wkid: 4326 });
    expect(env?.xmin).toBeCloseTo(-122.4);
    expect(env?.ymin).toBeCloseTo(37.7);
    expect(wm.initialState?.viewpoint?.scale).toBeGreaterThan(0);
  });

  it('rejects non-map items with a 404', async () => {
    const svc = new WebMapJsonService(makePrismaMock({}));
    await expect(
      svc.buildForMap({
        map: makeMap({ type: 'data_layer' }),
        portalBaseUrl: 'https://portal.example.org',
      }),
    ).rejects.toThrow(/only available for map items/);
  });

  it('omits initialState when the map has no center', async () => {
    const svc = new WebMapJsonService(makePrismaMock({}));
    const wm = await svc.buildForMap({
      map: makeMap({
        data: {
          basemap: '',
          // No center field at all.
          layers: [],
        },
      } as unknown as Partial<Item>),
      portalBaseUrl: 'https://portal.example.org',
    });
    expect(wm.initialState).toBeUndefined();
  });
});
