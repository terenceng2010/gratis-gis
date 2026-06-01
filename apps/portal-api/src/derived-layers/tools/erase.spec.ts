// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { eraseGenerator } from './erase.js';

describe('eraseGenerator', () => {
  it('exposes the right kind discriminator', () => {
    expect(eraseGenerator.kind).toBe('erase');
  });

  it('validates a well-formed params object', () => {
    const out = eraseGenerator.validate({
      otherSource: {
        kind: 'data_layer',
        itemId: '00000000-0000-0000-0000-000000000001',
      },
    });
    expect(out.otherSource.kind).toBe('data_layer');
    expect(out.otherSource.itemId).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('keeps an explicit layerKey', () => {
    const out = eraseGenerator.validate({
      otherSource: {
        kind: 'data_layer',
        itemId: 'abc',
        layerKey: 'masks',
      },
    });
    expect(out.otherSource.layerKey).toBe('masks');
  });

  it('rejects a missing otherSource', () => {
    expect(() => eraseGenerator.validate({})).toThrow(BadRequestException);
  });

  it('passes the upstream schema through unchanged', () => {
    const schema = [
      { name: 'id', label: 'ID', type: 'string' as const, nullable: false },
    ];
    expect(
      eraseGenerator.outputSchema(schema, {
        otherSource: { kind: 'data_layer', itemId: 'x' },
      }),
    ).toEqual(schema);
  });

  it('reports zero outward reach', () => {
    expect(eraseGenerator.outwardReachMeters()).toBe(0);
  });

  it('emits a SQL fragment that differences upstream against right_union', () => {
    const frag = eraseGenerator.toSql('source', {
      otherSource: { kind: 'data_layer', itemId: 'right-id' },
    });
    expect(frag.sql).toContain('right_rows AS');
    expect(frag.sql).toContain('right_union');
    expect(frag.sql).toContain('ST_Difference(l.geom, ru.geom)');
    expect(frag.sql).toContain('NOT ST_IsEmpty');
    // An empty right side must be COALESCEd to an empty geometry
    // so the ST_Difference call doesn't crash when no right rows
    // exist.
    expect(frag.sql).toContain('COALESCE');
    expect(frag.sql).toContain("GEOMETRYCOLLECTION EMPTY");
    expect(frag.params).toEqual([]);
  });
});
