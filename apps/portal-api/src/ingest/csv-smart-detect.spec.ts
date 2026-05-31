// SPDX-License-Identifier: AGPL-3.0-or-later
import { detectCsvCoordinates } from './csv-smart-detect.js';

/**
 * #160 Smart upload Phase 1 — unit tests for the coordinate-pair
 * detection helper. Exercises the column-name vocabulary, the
 * range-validation gate, the delimiter sniff, and the
 * fall-through path that lets the caller defer to GDAL when no
 * pair survives.
 */

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

describe('detectCsvCoordinates', () => {
  it('detects plain lat / lng headers', () => {
    const res = detectCsvCoordinates(
      buf('lat,lng,name\n40.7,-74.0,Office\n34.05,-118.25,Studio\n'),
    );
    expect(res.kind).toBe('detected');
    if (res.kind !== 'detected') return;
    expect(res.latColumn).toBe('lat');
    expect(res.lngColumn).toBe('lng');
    expect(res.geojson.features.length).toBe(2);
    const first = res.geojson.features[0] as {
      geometry: { type: 'Point'; coordinates: [number, number] };
      properties: Record<string, string>;
    };
    expect(first.geometry.type).toBe('Point');
    expect(first.geometry.coordinates).toEqual([-74.0, 40.7]);
    expect(first.properties.name).toBe('Office');
  });

  it('detects latitude / longitude with mixed case', () => {
    const res = detectCsvCoordinates(
      buf('Latitude,Longitude,site\n40.7,-74.0,A\n'),
    );
    expect(res.kind).toBe('detected');
  });

  it('detects x / y as a coordinate pair', () => {
    const res = detectCsvCoordinates(
      buf('id,name,X,Y\n1,Foo,-74.0,40.7\n2,Bar,-73.9,40.8\n'),
    );
    expect(res.kind).toBe('detected');
    if (res.kind !== 'detected') return;
    expect(res.latColumn).toBe('Y');
    expect(res.lngColumn).toBe('X');
  });

  it('handles tab-delimited files', () => {
    const res = detectCsvCoordinates(
      buf('lat\tlng\tname\n40.7\t-74.0\tOffice\n'),
    );
    expect(res.kind).toBe('detected');
  });

  it('falls through when no plausible columns exist', () => {
    const res = detectCsvCoordinates(
      buf('name,city,population\nA,NYC,8000000\nB,LA,4000000\n'),
    );
    expect(res.kind).toBe('no-coords');
  });

  it('rejects pairs whose values are out of range', () => {
    // Headers look right but values are far outside the legal
    // coord range (these would be UTM eastings / northings).
    const res = detectCsvCoordinates(
      buf('x,y,name\n583000,4507000,Plot1\n583100,4507100,Plot2\n'),
    );
    expect(res.kind).toBe('no-coords');
  });

  it('drops rows with non-numeric coords but emits valid ones', () => {
    // Mix mostly-valid rows with one bad row; validation ratio
    // stays above MIN_VALIDATION_RATIO (0.6) so detection succeeds.
    const res = detectCsvCoordinates(
      buf(
        'lat,lng,name\n' +
          '40.7,-74.0,A\n' +
          '40.8,-74.1,B\n' +
          '40.9,-74.2,C\n' +
          'NaN,-74.3,Junk\n' +
          '41.0,-74.4,D\n',
      ),
    );
    expect(res.kind).toBe('detected');
    if (res.kind !== 'detected') return;
    expect(res.geojson.features.length).toBe(4);
  });

  it('falls back when only one of the pair is present', () => {
    const res = detectCsvCoordinates(buf('lat,name\n40.7,A\n'));
    expect(res.kind).toBe('no-coords');
  });

  it('refuses an empty file gracefully', () => {
    expect(detectCsvCoordinates(buf('')).kind).toBe('no-coords');
  });

  it('refuses a header-only file gracefully', () => {
    expect(detectCsvCoordinates(buf('lat,lng,name\n')).kind).toBe('no-coords');
  });

  it('handles BOM-prefixed CSVs', () => {
    const res = detectCsvCoordinates(
      Buffer.from('﻿lat,lng,name\n40.7,-74.0,A\n', 'utf8'),
    );
    expect(res.kind).toBe('detected');
  });

  it('handles European decimal commas', () => {
    // Semicolon-delimited, decimal commas — common Excel-EU CSV
    // export. The delimiter sniff picks ; and the coord parser
    // promotes "40,7" to 40.7 because there's no other dot in
    // the value.
    const res = detectCsvCoordinates(
      buf('lat;lng;name\n40,7;-74,0;A\n34,05;-118,25;B\n'),
    );
    expect(res.kind).toBe('detected');
    if (res.kind !== 'detected') return;
    expect(res.geojson.features.length).toBe(2);
  });
});
