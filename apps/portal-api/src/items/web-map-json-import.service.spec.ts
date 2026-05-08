// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Item } from '@prisma/client';
import type { EsriWebMap } from '@gratis-gis/engine';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { WebMapJsonImportService } from './web-map-json-import.service.js';

/**
 * The import service does three things at the boundary:
 *   1. Calls webMapJsonToLenses on the engine package (covered by
 *      its own spec)
 *   2. Resolves URLs back to portal MapLayer sources
 *   3. Calls ItemsService.create with the resulting MapData
 *
 * These tests pin (2) and (3): the URL classification rules + the
 * shape of the MapData payload that lands in the new map item.
 * ItemsService is stubbed (`create` returns a fixed id); the
 * Prisma client is stubbed for the org-arcgis-item lookup and the
 * basemap match.
 */

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'alice',
    email: 'alice@example.com',
    orgRole: 'contributor',
    groupIds: [],
    capabilities: new Set(),
    ...overrides,
  } as AuthUser;
}

function makePrismaMock(opts: {
  arcgisItems?: Array<{ id: string; data: { url?: string } }>;
  basemapItems?: Array<{ id: string; data: { tileUrl?: string } }>;
} = {}) {
  return {
    item: {
      findMany: async (args: { where: { type: string } }) => {
        if (args.where.type === 'arcgis_service') {
          return opts.arcgisItems ?? [];
        }
        if (args.where.type === 'basemap') {
          return opts.basemapItems ?? [];
        }
        return [];
      },
    },
  } as unknown as ConstructorParameters<typeof WebMapJsonImportService>[0];
}

function makeItemsMock(): {
  service: ConstructorParameters<typeof WebMapJsonImportService>[1];
  lastCreate: { args: unknown };
} {
  const lastCreate: { args: unknown } = { args: undefined };
  const service = {
    create: async (_user: AuthUser, args: unknown) => {
      lastCreate.args = args;
      return { id: 'item-new', orgId: 'org-1' } as unknown as Item;
    },
  } as unknown as ConstructorParameters<typeof WebMapJsonImportService>[1];
  return { service, lastCreate };
}

const baseWebMap: EsriWebMap = {
  version: '2.32',
  authoringApp: 'Esri ArcGIS Online',
  authoringAppVersion: '2025.1',
  baseMap: {
    title: 'Streets',
    baseMapLayers: [
      {
        id: 'bm-1',
        title: 'Streets',
        url: 'https://basemaps.example.org/streets/{z}/{x}/{y}.png',
      },
    ],
  },
  initialState: {
    viewpoint: {
      targetGeometry: {
        xmin: -122.5,
        ymin: 37.7,
        xmax: -122.3,
        ymax: 37.9,
        spatialReference: { wkid: 4326 },
      },
      scale: 100000,
    },
  },
  operationalLayers: [
    {
      id: 'roads',
      title: 'Roads',
      url: 'https://services.example.com/arcgis/rest/services/Transport/FeatureServer/0',
      layerType: 'ArcGISFeatureLayer',
    },
    {
      id: 'parcels-mapserver',
      title: 'Parcels',
      url: 'https://services.example.com/arcgis/rest/services/Parcels/MapServer/3',
      layerType: 'ArcGISFeatureLayer',
    },
    {
      id: 'public-points',
      title: 'Public POIs',
      url: 'https://example.com/data/poi.geojson',
      layerType: 'ArcGISFeatureLayer',
    },
  ],
};

describe('WebMapJsonImportService', () => {
  it('creates a map item with one MapLayer per recognised operational layer', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    const result = await svc.import({
      user: makeUser(),
      webMap: baseWebMap,
    });
    expect(result.itemId).toBe('item-new');
    expect(result.layerCount).toBe(3);
    expect(result.skippedLayerCount).toBe(0);
    const args = items.lastCreate.args as {
      type: string;
      data: { layers: Array<{ source: { kind: string } }> };
    };
    expect(args.type).toBe('map');
    expect(args.data.layers).toHaveLength(3);
    const kinds = args.data.layers.map((l) => l.source.kind);
    expect(kinds).toEqual(['arcgis-rest', 'arcgis-rest', 'geojson-url']);
  });

  it('parses out FeatureServer / MapServer layer ids', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    await svc.import({ user: makeUser(), webMap: baseWebMap });
    const args = items.lastCreate.args as {
      data: {
        layers: Array<{
          source: {
            kind: string;
            url?: string;
            layerId?: number;
            serviceType?: string;
          };
        }>;
      };
    };
    expect(args.data.layers[0]?.source).toEqual({
      kind: 'arcgis-rest',
      url: 'https://services.example.com/arcgis/rest/services/Transport/FeatureServer',
      layerId: 0,
      serviceType: 'FeatureServer',
    });
    expect(args.data.layers[1]?.source).toEqual({
      kind: 'arcgis-rest',
      url: 'https://services.example.com/arcgis/rest/services/Parcels/MapServer',
      layerId: 3,
      serviceType: 'MapServer',
    });
    expect(args.data.layers[2]?.source).toEqual({
      kind: 'geojson-url',
      url: 'https://example.com/data/poi.geojson',
    });
  });

  it('back-references the org\'s arcgis_service item when URL matches', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(
      makePrismaMock({
        arcgisItems: [
          {
            id: 'arcgis-portal-1',
            data: {
              url: 'https://services.example.com/arcgis/rest/services/Transport/FeatureServer/0',
            },
          },
        ],
      }),
      items.service,
    );
    await svc.import({ user: makeUser(), webMap: baseWebMap });
    const args = items.lastCreate.args as {
      data: { layers: Array<{ source: { sourceItemId?: string } }> };
    };
    expect(args.data.layers[0]?.source.sourceItemId).toBe('arcgis-portal-1');
    // Layers without a matching portal item omit sourceItemId.
    expect(args.data.layers[1]?.source.sourceItemId).toBeUndefined();
  });

  it('resolves the basemap by tileUrl match', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(
      makePrismaMock({
        basemapItems: [
          {
            id: 'basemap-streets',
            data: {
              tileUrl: 'https://basemaps.example.org/streets/{z}/{x}/{y}.png',
            },
          },
        ],
      }),
      items.service,
    );
    await svc.import({ user: makeUser(), webMap: baseWebMap });
    const args = items.lastCreate.args as { data: { basemap: string } };
    expect(args.data.basemap).toBe('basemap-streets');
  });

  it('falls back to the empty-string basemap sentinel when no item matches', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    await svc.import({ user: makeUser(), webMap: baseWebMap });
    const args = items.lastCreate.args as { data: { basemap: string } };
    expect(args.data.basemap).toBe('');
  });

  it('emits center+zoom from initialState.viewpoint', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    await svc.import({ user: makeUser(), webMap: baseWebMap });
    const args = items.lastCreate.args as {
      data: { center: [number, number]; zoom: number };
    };
    expect(args.data.center[0]).toBeCloseTo(-122.4);
    expect(args.data.center[1]).toBeCloseTo(37.8);
    expect(args.data.zoom).toBeGreaterThan(10);
    expect(args.data.zoom).toBeLessThan(14);
  });

  it('uses default center+zoom when initialState is missing', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    const noView = { ...baseWebMap } as EsriWebMap;
    delete (noView as { initialState?: unknown }).initialState;
    await svc.import({ user: makeUser(), webMap: noView });
    const args = items.lastCreate.args as {
      data: { center: [number, number]; zoom: number };
    };
    expect(args.data.center).toEqual([0, 0]);
    expect(args.data.zoom).toBe(2);
  });

  it('skips unsupported layer types and surfaces a warning', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    const wm: EsriWebMap = {
      ...baseWebMap,
      operationalLayers: [
        {
          id: 'tiled',
          title: 'Tiled',
          url: 'https://example.com/tiles',
          layerType: 'WebTiledLayer',
        },
        {
          id: 'good',
          title: 'Good FS',
          url: 'https://services.example.com/arcgis/rest/services/X/FeatureServer/0',
          layerType: 'ArcGISFeatureLayer',
        },
      ],
    };
    const result = await svc.import({ user: makeUser(), webMap: wm });
    expect(result.layerCount).toBe(1);
    expect(
      result.warnings.some((w) => /unsupported layerType/.test(w)),
    ).toBe(true);
  });

  it('honours title + description overrides', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    await svc.import({
      user: makeUser(),
      webMap: baseWebMap,
      title: 'Quarterly review map',
      description: 'Imported from AGO Q3 2025 review.',
    });
    const args = items.lastCreate.args as {
      title: string;
      description?: string;
    };
    expect(args.title).toBe('Quarterly review map');
    expect(args.description).toBe('Imported from AGO Q3 2025 review.');
  });

  it('falls back to authoringApp + "import" when no title is given', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    await svc.import({ user: makeUser(), webMap: baseWebMap });
    const args = items.lastCreate.args as { title: string };
    expect(args.title).toMatch(/Esri ArcGIS Online import/);
  });

  it('rejects a WebMap with no usable operational layers', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    const wm: EsriWebMap = {
      ...baseWebMap,
      operationalLayers: [
        {
          id: 'tiled',
          title: 'Only tiled',
          url: 'https://example.com/t',
          layerType: 'WebTiledLayer',
        },
      ],
    };
    await expect(svc.import({ user: makeUser(), webMap: wm })).rejects.toThrow(
      /zero usable layers/,
    );
  });

  it('rejects a WebMap missing the version field', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    const wm = { ...baseWebMap } as EsriWebMap;
    delete (wm as { version?: string }).version;
    await expect(svc.import({ user: makeUser(), webMap: wm })).rejects.toThrow(
      /missing or empty .version/,
    );
  });
});
