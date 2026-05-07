// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  H3_RESOLUTION,
  cellForGeometry,
  representativePoint,
} from '@gratis-gis/engine';
import { getResolution } from 'h3-js';

describe('representativePoint', () => {
  it('returns the coordinates of a Point', () => {
    expect(
      representativePoint({ type: 'Point', coordinates: [-111.65, 40.6] }),
    ).toEqual([-111.65, 40.6]);
  });

  it('returns the first vertex of a LineString', () => {
    expect(
      representativePoint({
        type: 'LineString',
        coordinates: [
          [-111.65, 40.6],
          [-111.66, 40.61],
        ],
      }),
    ).toEqual([-111.65, 40.6]);
  });

  it('returns the first vertex of the outer ring of a Polygon', () => {
    expect(
      representativePoint({
        type: 'Polygon',
        coordinates: [
          [
            [-111.65, 40.6],
            [-111.66, 40.6],
            [-111.66, 40.61],
            [-111.65, 40.61],
            [-111.65, 40.6],
          ],
        ],
      }),
    ).toEqual([-111.65, 40.6]);
  });

  it('returns the first vertex of the first polygon of a MultiPolygon', () => {
    expect(
      representativePoint({
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [-111.65, 40.6],
              [-111.66, 40.6],
              [-111.66, 40.61],
              [-111.65, 40.6],
            ],
          ],
        ],
      }),
    ).toEqual([-111.65, 40.6]);
  });

  it('returns null for an empty MultiPoint', () => {
    expect(representativePoint({ type: 'MultiPoint', coordinates: [] })).toBe(
      null,
    );
  });
});

describe('cellForGeometry', () => {
  it('returns null when the geometry is null', () => {
    expect(cellForGeometry(null)).toBe(null);
  });

  it('returns an H3 cell at resolution 7 for a Point', () => {
    const cell = cellForGeometry({
      type: 'Point',
      coordinates: [-111.65, 40.6],
    });
    expect(cell).not.toBe(null);
    expect(getResolution(cell as string)).toBe(H3_RESOLUTION);
  });

  it('returns the same cell for points within the same H3 hexagon', () => {
    // Two points roughly 100m apart near Salt Lake City fall in the
    // same H3 res-7 cell (~5km edge length).
    const a = cellForGeometry({
      type: 'Point',
      coordinates: [-111.6500, 40.6000],
    });
    const b = cellForGeometry({
      type: 'Point',
      coordinates: [-111.6510, 40.6005],
    });
    expect(a).toBe(b);
  });

  it('returns a cell for a Polygon (using the first vertex)', () => {
    const cell = cellForGeometry({
      type: 'Polygon',
      coordinates: [
        [
          [-111.65, 40.6],
          [-111.66, 40.6],
          [-111.66, 40.61],
          [-111.65, 40.61],
          [-111.65, 40.6],
        ],
      ],
    });
    expect(cell).not.toBe(null);
    expect(getResolution(cell as string)).toBe(H3_RESOLUTION);
  });
});
