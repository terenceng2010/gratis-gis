// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  lensToWebMapJson,
  webMapJsonToLens,
} from '@gratis-gis/engine';
import type {
  EsriWebMap,
  Lens,
  WebMapJsonContext,
} from '@gratis-gis/engine';

const ctx: WebMapJsonContext = {
  lensUrlPrefix: 'https://portal.example.org/api/lenses',
  basemap: {
    id: 'basemap-positron',
    title: 'Positron',
    tileUrl: 'https://basemaps.example.org/positron/{z}/{x}/{y}.png',
    attribution: '(c) Carto',
  },
};

describe('lensToWebMapJson', () => {
  it('emits an ArcGISFeatureLayer for a geojson-render lens', () => {
    const lens: Lens = {
      id: 'lens-parcels',
      name: 'Parcels',
      query: { scopes: ['data_layer:abc:lyr'] },
      render: { kind: 'geojson' },
    };
    const wm = lensToWebMapJson(lens, ctx);
    expect(wm.version).toMatch(/^2\./);
    expect(wm.operationalLayers).toHaveLength(1);
    const layer = wm.operationalLayers![0]!;
    expect(layer.layerType).toBe('ArcGISFeatureLayer');
    expect(layer.title).toBe('Parcels');
    expect(layer.url).toBe(
      'https://portal.example.org/api/lenses/lens-parcels/features',
    );
    expect(wm.baseMap?.baseMapLayers[0]?.url).toBe(ctx.basemap.tileUrl);
  });

  it('emits a VectorTileLayer for an mvt-render lens', () => {
    const lens: Lens = {
      id: 'lens-mvt',
      name: 'Tiles',
      query: { scopes: ['data_layer:abc:lyr'] },
      render: { kind: 'mvt' },
    };
    const wm = lensToWebMapJson(lens, ctx);
    expect(wm.operationalLayers![0]?.layerType).toBe('VectorTileLayer');
    expect(wm.operationalLayers![0]?.url).toContain('{z}/{y}/{x}.pbf');
  });

  it('skips operational layers for non-map renderers', () => {
    const lens: Lens = {
      id: 'lens-scalar',
      name: 'Total cost',
      query: { scopes: ['data_layer:abc:lyr'] },
      render: { kind: 'scalar_json', expr: 'sum(attrs->>cost)' },
    };
    expect(lensToWebMapJson(lens, ctx).operationalLayers).toEqual([]);
  });

  it('translates a single-clause attrFilter to a definitionExpression', () => {
    const lens: Lens = {
      id: 'lens-filtered',
      name: 'Big parcels',
      query: {
        scopes: ['data_layer:abc:lyr'],
        attrFilter: { field: 'area', op: 'gte', value: 5000 },
      },
      render: { kind: 'geojson' },
    };
    const wm = lensToWebMapJson(lens, ctx);
    expect(
      wm.operationalLayers![0]?.layerDefinition?.definitionExpression,
    ).toBe('"area" >= 5000');
  });

  it('translates IN with a list literal', () => {
    const lens: Lens = {
      id: 'lens-multi',
      name: 'Selected statuses',
      query: {
        scopes: ['s'],
        attrFilter: {
          field: 'status',
          op: 'in',
          value: ['active', 'pending'],
        },
      },
      render: { kind: 'geojson' },
    };
    expect(
      lensToWebMapJson(lens, ctx).operationalLayers![0]?.layerDefinition
        ?.definitionExpression,
    ).toBe(`"status" IN ('active', 'pending')`);
  });

  it('emits a viewpoint when the lens has a view', () => {
    const lens: Lens = {
      id: 'lens-view',
      name: 'Around HQ',
      query: { scopes: ['s'] },
      render: { kind: 'geojson' },
      view: { center: [-122.4, 37.7], zoom: 10 },
    };
    const wm = lensToWebMapJson(lens, ctx);
    expect(wm.initialState?.viewpoint?.targetGeometry?.spatialReference).toEqual(
      { wkid: 4326 },
    );
    expect(wm.initialState?.viewpoint?.scale).toBeGreaterThan(0);
  });
});

describe('webMapJsonToLens', () => {
  it('round-trips a geojson lens through emit + import', () => {
    const lens: Lens = {
      id: 'lens-rt',
      name: 'Round trip',
      query: {
        scopes: ['data_layer:abc:lyr'],
        attrFilter: { field: 'name', op: 'eq', value: "O'Brien" },
      },
      render: { kind: 'geojson' },
    };
    const wm = lensToWebMapJson(lens, ctx);
    const { lens: imported, warnings } = webMapJsonToLens(wm);
    expect(warnings).toEqual([]);
    expect(imported.name).toBe('Round trip');
    expect(imported.render.kind).toBe('geojson');
    expect(imported.query.attrFilter).toEqual({
      field: 'name',
      op: 'eq',
      value: "O'Brien",
    });
  });

  it('rejects a WebMap with no usable operational layer', () => {
    const empty: EsriWebMap = { version: '2.32', operationalLayers: [] };
    expect(() => webMapJsonToLens(empty)).toThrow(
      /no ArcGISFeatureLayer or VectorTileLayer/,
    );
  });

  it('rejects a WebMap missing version', () => {
    const bad = {
      operationalLayers: [
        {
          id: 'l',
          title: 't',
          url: 'u',
          layerType: 'ArcGISFeatureLayer',
        },
      ],
    } as unknown as EsriWebMap;
    expect(() => webMapJsonToLens(bad)).toThrow(/missing or empty .version/);
  });

  it('warns and drops the filter for unrecognised definition expressions', () => {
    const wm: EsriWebMap = {
      version: '2.32',
      operationalLayers: [
        {
          id: 'l',
          title: 'L',
          url: 'https://example.com/layer',
          layerType: 'ArcGISFeatureLayer',
          layerDefinition: {
            // Multi-clause; not in the v1 supported subset.
            definitionExpression: '"a" = 1 AND "b" = 2',
          },
        },
      ],
    };
    const { lens, warnings } = webMapJsonToLens(wm);
    expect(lens.query.attrFilter).toBeUndefined();
    expect(warnings.some((w) => /not recognised/.test(w))).toBe(true);
  });

  it('warns when multiple operational layers are present', () => {
    const wm: EsriWebMap = {
      version: '2.32',
      operationalLayers: [
        {
          id: 'a',
          title: 'A',
          url: 'https://example.com/a',
          layerType: 'ArcGISFeatureLayer',
        },
        {
          id: 'b',
          title: 'B',
          url: 'https://example.com/b',
          layerType: 'ArcGISFeatureLayer',
        },
      ],
    };
    const { warnings } = webMapJsonToLens(wm);
    expect(warnings.some((w) => /Only the first/.test(w))).toBe(true);
  });
});
