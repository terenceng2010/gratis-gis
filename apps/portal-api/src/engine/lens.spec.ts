// SPDX-License-Identifier: AGPL-3.0-or-later
import { bboxFromGeometry, isLens } from '@gratis-gis/engine';
import type { Lens } from '@gratis-gis/engine';

describe('isLens', () => {
  it('accepts a minimal lens', () => {
    const lens: Lens = {
      id: 'lens-1',
      name: 'Parcels',
      query: { scopes: ['data_layer:abc:lyr'] },
      render: { kind: 'geojson' },
    };
    expect(isLens(lens)).toBe(true);
  });

  it('rejects objects missing required fields', () => {
    expect(isLens(null)).toBe(false);
    expect(isLens({})).toBe(false);
    expect(isLens({ id: 'x' })).toBe(false);
    expect(isLens({ id: 'x', name: 'y' })).toBe(false);
    expect(
      isLens({ id: 'x', name: 'y', query: { scopes: 'nope' }, render: {} }),
    ).toBe(false);
    expect(
      isLens({ id: 'x', name: 'y', query: { scopes: [] } }),
    ).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isLens(42)).toBe(false);
    expect(isLens('lens')).toBe(false);
    expect(isLens(undefined)).toBe(false);
  });
});

describe('bboxFromGeometry', () => {
  it('handles a Point as a degenerate envelope', () => {
    expect(
      bboxFromGeometry({ type: 'Point', coordinates: [1, 2] }),
    ).toEqual([1, 2, 1, 2]);
  });

  it('returns the right envelope for a Polygon', () => {
    const env = bboxFromGeometry({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 5],
          [0, 5],
          [0, 0],
        ],
      ],
    });
    expect(env).toEqual([0, 0, 10, 5]);
  });

  it('handles MultiPolygon by visiting every ring', () => {
    const env = bboxFromGeometry({
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
        [
          [
            [-5, -3],
            [-4, -3],
            [-4, -2],
            [-5, -2],
            [-5, -3],
          ],
        ],
      ],
    });
    expect(env).toEqual([-5, -3, 1, 1]);
  });

  it('throws for an empty coordinate set', () => {
    expect(() =>
      bboxFromGeometry({ type: 'LineString', coordinates: [] }),
    ).toThrow(/no usable coordinates/);
  });
});
