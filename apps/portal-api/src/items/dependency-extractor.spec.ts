// SPDX-License-Identifier: AGPL-3.0-or-later
import { extractDependencies } from './dependency-extractor.js';

describe('extractDependencies for derived_layer', () => {
  it('emits the source data layer as a hard forward edge', () => {
    const result = extractDependencies({
      type: 'derived_layer' as const,
      data: {
        version: 1,
        source: {
          kind: 'data_layer',
          itemId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        },
        pipeline: [
          { tool: 'buffer', params: { distance: 100, unit: 'meters' } },
        ],
        featureLimit: 1000,
        outputSchema: [],
        bbox: [],
      },
    });
    expect(result.itemIds).toEqual([
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    ]);
    expect(result.urls).toEqual([]);
  });

  it('returns no edges when the source ref is missing', () => {
    const result = extractDependencies({
      type: 'derived_layer' as const,
      data: { version: 1, pipeline: [] },
    });
    expect(result).toEqual({ itemIds: [], urls: [] });
  });

  it('returns no edges when source.itemId is the empty string', () => {
    const result = extractDependencies({
      type: 'derived_layer' as const,
      data: {
        version: 1,
        source: { kind: 'data_layer', itemId: '' },
        pipeline: [],
      },
    });
    expect(result).toEqual({ itemIds: [], urls: [] });
  });
});

describe('extractDependencies for custom web_app', () => {
  // Custom Web App items live as type='web_app' with
  // data.template='custom'. The dep walk must reach the app-level
  // mapId, every per-Map-widget mapId override, and every target's
  // dataLayerId so the cascade-on-public dialog (#310) doesn't
  // silently dismiss when the author makes a custom app public
  // that embeds private maps / private data_layers (the WV Parcel
  // Viewer symptom).
  const buildCustom = (custom: Record<string, unknown>) => ({
    type: 'web_app' as const,
    data: {
      template: 'custom',
      config: { template: 'custom', custom },
    },
  });

  it('emits the app-level mapId and every target dataLayerId', () => {
    const result = extractDependencies(
      buildCustom({
        version: 3,
        mapId: 'mmmmmmmm-mmmm-mmmm-mmmm-mmmmmmmmmmmm',
        targets: [
          {
            dataLayerId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
            layerKey: 'layer-1',
          },
          {
            dataLayerId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
            layerKey: 'layer-2',
          },
        ],
        pages: [],
      }),
    );
    expect([...result.itemIds].sort()).toEqual([
      'dddddddd-dddd-dddd-dddd-dddddddddddd',
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      'mmmmmmmm-mmmm-mmmm-mmmm-mmmmmmmmmmmm',
    ]);
    expect(result.urls).toEqual([]);
  });

  it('emits per-Map-widget mapId overrides across pages', () => {
    const result = extractDependencies(
      buildCustom({
        version: 3,
        targets: [],
        pages: [
          {
            id: 'home',
            title: 'Home',
            widgets: [
              {
                id: 'w1',
                kind: 'map',
                config: {
                  kind: 'map',
                  mapId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                },
              },
              {
                id: 'w2',
                kind: 'text',
                config: { kind: 'text', markdown: '' },
              },
            ],
          },
          {
            id: 'second',
            title: 'Second',
            widgets: [
              {
                id: 'w3',
                kind: 'map',
                config: {
                  kind: 'map',
                  mapId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                },
              },
            ],
          },
        ],
      }),
    );
    expect([...result.itemIds].sort()).toEqual([
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    ]);
  });

  it('returns no edges for an empty custom app', () => {
    const result = extractDependencies(
      buildCustom({ version: 3, targets: [], pages: [] }),
    );
    expect(result).toEqual({ itemIds: [], urls: [] });
  });

  it('emits file-item asset refs from image widgets', () => {
    const result = extractDependencies(
      buildCustom({
        version: 3,
        targets: [],
        pages: [
          {
            id: 'home',
            title: 'Home',
            widgets: [
              {
                id: 'w1',
                kind: 'image',
                config: {
                  kind: 'image',
                  asset: {
                    kind: 'file-item',
                    itemId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
                    cachedUrl:
                      '/api/portal/storage/private/item-file/some-key',
                  },
                },
              },
            ],
          },
        ],
      }),
    );
    expect(result.itemIds).toEqual([
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
    ]);
  });

  it('skips external-url asset refs', () => {
    const result = extractDependencies(
      buildCustom({
        version: 3,
        targets: [],
        pages: [
          {
            id: 'home',
            title: 'Home',
            widgets: [
              {
                id: 'w1',
                kind: 'image',
                config: {
                  kind: 'image',
                  asset: {
                    kind: 'external-url',
                    url: 'https://cdn.example.com/logo.png',
                  },
                },
              },
            ],
          },
        ],
      }),
    );
    expect(result).toEqual({ itemIds: [], urls: [] });
  });

  it('skips legacy image widgets with only bare url', () => {
    // Legacy widgets pre-AssetRef have `url` but no `asset`. The
    // extractor can't recover an itemId from a URL synchronously,
    // so these are intentionally not crawled. Surfaced as a separate
    // future task: a one-off migration that backfills AssetRef from
    // any URL pointing at /api/portal/storage/private/item-file/...
    const result = extractDependencies(
      buildCustom({
        version: 3,
        targets: [],
        pages: [
          {
            id: 'home',
            title: 'Home',
            widgets: [
              {
                id: 'w1',
                kind: 'image',
                config: {
                  kind: 'image',
                  url: '/api/portal/storage/private/item-file/some-key',
                },
              },
            ],
          },
        ],
      }),
    );
    expect(result).toEqual({ itemIds: [], urls: [] });
  });
});
