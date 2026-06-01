// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { clipGenerator } from './clip.js';

describe('clipGenerator', () => {
  it('exposes the right kind discriminator', () => {
    expect(clipGenerator.kind).toBe('clip');
  });

  it('validates a well-formed params object', () => {
    const out = clipGenerator.validate({
      otherSource: {
        kind: 'data_layer',
        itemId: '00000000-0000-0000-0000-000000000001',
      },
    });
    expect(out.otherSource.kind).toBe('data_layer');
    expect(out.otherSource.itemId).toBe('00000000-0000-0000-0000-000000000001');
    expect(out.otherSource.layerKey).toBeUndefined();
  });

  it('keeps an explicit layerKey', () => {
    const out = clipGenerator.validate({
      otherSource: {
        kind: 'data_layer',
        itemId: 'abc',
        layerKey: 'parcels',
      },
    });
    expect(out.otherSource.layerKey).toBe('parcels');
  });

  it('rejects a missing otherSource', () => {
    expect(() => clipGenerator.validate({})).toThrow(BadRequestException);
  });

  it('rejects a wrong-kind otherSource', () => {
    expect(() =>
      clipGenerator.validate({
        otherSource: { kind: 'derived_layer', itemId: 'x' },
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects an empty itemId', () => {
    expect(() =>
      clipGenerator.validate({
        otherSource: { kind: 'data_layer', itemId: '' },
      }),
    ).toThrow(BadRequestException);
  });

  it('passes the upstream schema through unchanged', () => {
    const schema = [
      { name: 'parcel_id', label: 'Parcel ID', type: 'string' as const, nullable: false },
      { name: 'acres', label: 'Acres', type: 'number' as const, nullable: true },
    ];
    expect(
      clipGenerator.outputSchema(schema, {
        otherSource: { kind: 'data_layer', itemId: 'x' },
      }),
    ).toEqual(schema);
  });

  it('reports zero outward reach', () => {
    expect(
      clipGenerator.outwardReachMeters({
        otherSource: { kind: 'data_layer', itemId: 'x' },
      }),
    ).toBe(0);
  });

  it('extracts the right itemId as a dependency', () => {
    const deps = clipGenerator.extractDependencies({
      otherSource: { kind: 'data_layer', itemId: 'right-id' },
    });
    expect(deps.itemIds).toEqual(['right-id']);
    expect(deps.urls).toEqual([]);
  });

  it('emits a SQL fragment that intersects upstream with right_union', () => {
    const frag = clipGenerator.toSql(
      'source',
      { otherSource: { kind: 'data_layer', itemId: 'right-id' } },
      0,
    );
    expect(frag.sql).toContain('right_rows AS');
    expect(frag.sql).toContain('right_union');
    expect(frag.sql).toContain('ST_Intersection(l.geom, ru.geom)');
    expect(frag.sql).toContain('ST_Intersects(l.geom, ru.geom)');
    expect(frag.sql).toContain('NOT ST_IsEmpty');
    // Clip is parameter-free in its toSql output - the right CTE
    // is composed via the engine's data_layer fragment which
    // doesn't need additional params for the current-truth view.
    expect(frag.params).toEqual([]);
  });
});
