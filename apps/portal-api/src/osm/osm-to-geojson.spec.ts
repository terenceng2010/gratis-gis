// SPDX-License-Identifier: AGPL-3.0-or-later
import { osmToGeoJson, type OverpassResponse } from './osm-to-geojson.js';

describe('osmToGeoJson', () => {
  it('returns an empty FeatureCollection for an empty response', () => {
    const out = osmToGeoJson({});
    expect(out).toEqual({ type: 'FeatureCollection', features: [] });
  });

  it('converts a node to a Point feature', () => {
    const out = osmToGeoJson({
      elements: [
        {
          type: 'node',
          id: 1,
          lat: 38.5,
          lon: -80.1,
          tags: { amenity: 'fuel', brand: 'Citgo' },
        },
      ],
    });
    expect(out.features).toHaveLength(1);
    const f = out.features[0]!;
    expect(f.id).toBe('node/1');
    expect(f.geometry).toEqual({
      type: 'Point',
      coordinates: [-80.1, 38.5],
    });
    expect(f.properties).toMatchObject({
      osmType: 'node',
      osmId: 1,
      amenity: 'fuel',
      brand: 'Citgo',
    });
  });

  it('converts an open way to a LineString', () => {
    const out = osmToGeoJson({
      elements: [
        {
          type: 'way',
          id: 2,
          geometry: [
            { lat: 38.0, lon: -80.0 },
            { lat: 38.0, lon: -79.5 },
            { lat: 38.5, lon: -79.5 },
          ],
          tags: { highway: 'residential' },
        },
      ],
    });
    expect(out.features[0]!.geometry.type).toBe('LineString');
  });

  it('converts a closed area-tagged way to a Polygon', () => {
    const out = osmToGeoJson({
      elements: [
        {
          type: 'way',
          id: 3,
          geometry: [
            { lat: 38.0, lon: -80.0 },
            { lat: 38.0, lon: -79.5 },
            { lat: 38.5, lon: -79.5 },
            { lat: 38.5, lon: -80.0 },
            { lat: 38.0, lon: -80.0 },
          ],
          tags: { building: 'yes' },
        },
      ],
    });
    expect(out.features[0]!.geometry.type).toBe('Polygon');
  });

  it('keeps a closed highway as a LineString (forbidden area key)', () => {
    const out = osmToGeoJson({
      elements: [
        {
          type: 'way',
          id: 4,
          geometry: [
            { lat: 38.0, lon: -80.0 },
            { lat: 38.0, lon: -79.5 },
            { lat: 38.5, lon: -79.5 },
            { lat: 38.0, lon: -80.0 },
          ],
          tags: { highway: 'residential', area: undefined as unknown as string },
        },
      ],
    });
    expect(out.features[0]!.geometry.type).toBe('LineString');
  });

  it('honours explicit area=yes on a non-area tag set', () => {
    const out = osmToGeoJson({
      elements: [
        {
          type: 'way',
          id: 5,
          geometry: [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 1 },
            { lat: 1, lon: 1 },
            { lat: 0, lon: 0 },
          ],
          tags: { area: 'yes', name: 'plaza' },
        },
      ],
    });
    expect(out.features[0]!.geometry.type).toBe('Polygon');
  });

  it('assembles a multipolygon relation from outer + inner ways', () => {
    const out = osmToGeoJson({
      elements: [
        {
          type: 'relation',
          id: 100,
          tags: { type: 'multipolygon', natural: 'water' },
          members: [
            {
              type: 'way',
              ref: 101,
              role: 'outer',
              geometry: [
                { lat: 0, lon: 0 },
                { lat: 0, lon: 1 },
                { lat: 1, lon: 1 },
                { lat: 1, lon: 0 },
                { lat: 0, lon: 0 },
              ],
            },
            {
              type: 'way',
              ref: 102,
              role: 'inner',
              geometry: [
                { lat: 0.4, lon: 0.4 },
                { lat: 0.4, lon: 0.6 },
                { lat: 0.6, lon: 0.6 },
                { lat: 0.6, lon: 0.4 },
                { lat: 0.4, lon: 0.4 },
              ],
            },
          ],
        },
      ],
    });
    expect(out.features).toHaveLength(1);
    const f = out.features[0]!;
    expect(f.id).toBe('relation/100');
    expect(f.geometry.type).toBe('Polygon');
    // Polygon: [outer, inner]
    const poly = f.geometry as import('./osm-to-geojson.js').OsmGeoJsonPolygon;
    expect(poly.coordinates).toHaveLength(2);
    expect(poly.coordinates[0]!).toHaveLength(5);
    expect(poly.coordinates[1]!).toHaveLength(5);
  });

  it('skips relations of unsupported type with a warn', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = osmToGeoJson({
      elements: [
        {
          type: 'relation',
          id: 200,
          tags: { type: 'route', route: 'bicycle' },
          members: [],
        },
      ],
    });
    expect(out.features).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips a way with no geometry', () => {
    const out = osmToGeoJson({
      elements: [{ type: 'way', id: 6, tags: { highway: 'path' } }],
    });
    expect(out.features).toHaveLength(0);
  });

  it('glues two disjoint outer ways into a closed ring', () => {
    const out = osmToGeoJson({
      elements: [
        {
          type: 'relation',
          id: 300,
          tags: { type: 'multipolygon', leisure: 'park' },
          members: [
            {
              type: 'way',
              ref: 301,
              role: 'outer',
              geometry: [
                { lat: 0, lon: 0 },
                { lat: 0, lon: 1 },
                { lat: 1, lon: 1 },
              ],
            },
            {
              type: 'way',
              ref: 302,
              role: 'outer',
              geometry: [
                { lat: 1, lon: 1 },
                { lat: 1, lon: 0 },
                { lat: 0, lon: 0 },
              ],
            },
          ],
        },
      ],
    });
    expect(out.features).toHaveLength(1);
    const poly = out.features[0]!.geometry as import('./osm-to-geojson.js').OsmGeoJsonPolygon;
    expect(poly.coordinates[0]).toHaveLength(5); // 3 + 3 - 1 shared
  });
});
