// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import type { FeatureField } from '@gratis-gis/shared-types';

import { contourGenerator } from './contour.js';
import type { ContourParams } from './contour.js';

const POINT_FIELDS: FeatureField[] = [
  { name: 'well_id', label: 'Well ID', type: 'string', nullable: false },
  {
    name: 'water_level_ft',
    label: 'Water level (ft)',
    type: 'number',
    nullable: false,
  },
  { name: 'site', label: 'Site', type: 'string', nullable: true },
];

function valid(): ContourParams {
  return {
    field: 'water_level_ft',
    mode: 'auto',
    interval: 5,
  };
}

describe('contourGenerator.validate', () => {
  it('accepts a well-formed auto-mode param block', () => {
    const ctx = { sourceSchema: POINT_FIELDS };
    expect(contourGenerator.validate(valid(), ctx)).toMatchObject({
      field: 'water_level_ft',
      mode: 'auto',
      interval: 5,
    });
  });

  it('accepts manual mode with a sorted-ascending levels list', () => {
    const ctx = { sourceSchema: POINT_FIELDS };
    const p = contourGenerator.validate(
      {
        field: 'water_level_ft',
        mode: 'manual',
        levels: [100, 110, 120, 130],
      },
      ctx,
    );
    expect(p.levels).toEqual([100, 110, 120, 130]);
  });

  it('rejects non-numeric source fields', () => {
    const ctx = { sourceSchema: POINT_FIELDS };
    expect(() =>
      contourGenerator.validate(
        { field: 'site', mode: 'auto', interval: 1 },
        ctx,
      ),
    ).toThrow(/must be a number field/);
  });

  it('rejects a field that does not exist on the source', () => {
    const ctx = { sourceSchema: POINT_FIELDS };
    expect(() =>
      contourGenerator.validate(
        { field: 'unknown_thing', mode: 'auto', interval: 1 },
        ctx,
      ),
    ).toThrow(/does not exist/);
  });

  it('rejects non-positive interval in auto mode', () => {
    const ctx = { sourceSchema: POINT_FIELDS };
    expect(() =>
      contourGenerator.validate(
        { field: 'water_level_ft', mode: 'auto', interval: 0 },
        ctx,
      ),
    ).toThrow(/positive number/);
  });

  it('rejects unsorted manual levels', () => {
    const ctx = { sourceSchema: POINT_FIELDS };
    expect(() =>
      contourGenerator.validate(
        {
          field: 'water_level_ft',
          mode: 'manual',
          levels: [10, 5, 20],
        },
        ctx,
      ),
    ).toThrow(/sorted ascending/);
  });

  it('rejects manual mode with no levels', () => {
    const ctx = { sourceSchema: POINT_FIELDS };
    expect(() =>
      contourGenerator.validate(
        { field: 'water_level_ft', mode: 'manual', levels: [] },
        ctx,
      ),
    ).toThrow(/non-empty array/);
  });

  it('rejects minLevel >= maxLevel in auto mode', () => {
    const ctx = { sourceSchema: POINT_FIELDS };
    expect(() =>
      contourGenerator.validate(
        {
          field: 'water_level_ft',
          mode: 'auto',
          interval: 1,
          minLevel: 10,
          maxLevel: 10,
        },
        ctx,
      ),
    ).toThrow(/strictly less than/);
  });

  it('rejects a non-object', () => {
    expect(() => contourGenerator.validate(null)).toThrow(BadRequestException);
    expect(() => contourGenerator.validate([])).toThrow(BadRequestException);
  });
});

describe('contourGenerator.enrich', () => {
  it('stamps cachedLevels by walking min/max at the chosen interval', async () => {
    const fake = {
      sourceSchema: POINT_FIELDS,
      sourceTable: '(SELECT 1) src',
      queryRaw: jest.fn(async () => [{ minv: 100, maxv: 130 }]),
    } as unknown as Parameters<
      NonNullable<typeof contourGenerator.enrich>
    >[1];
    const out = await contourGenerator.enrich!(
      { field: 'water_level_ft', mode: 'auto', interval: 10 },
      fake,
    );
    // Walks from ceil(100/10)*10 = 100 by 10s up to 130 inclusive.
    expect(out.cachedLevels).toEqual([100, 110, 120, 130]);
  });

  it('snaps the first level UP to the nearest interval multiple', async () => {
    const fake = {
      sourceSchema: POINT_FIELDS,
      sourceTable: '(SELECT 1) src',
      queryRaw: jest.fn(async () => [{ minv: 103, maxv: 128 }]),
    } as unknown as Parameters<
      NonNullable<typeof contourGenerator.enrich>
    >[1];
    const out = await contourGenerator.enrich!(
      { field: 'water_level_ft', mode: 'auto', interval: 10 },
      fake,
    );
    // ceil(103/10)*10 = 110, so we start at 110.
    expect(out.cachedLevels).toEqual([110, 120]);
  });

  it('caps at 100 levels even if the range would generate more', async () => {
    const fake = {
      sourceSchema: POINT_FIELDS,
      sourceTable: '(SELECT 1) src',
      queryRaw: jest.fn(async () => [{ minv: 0, maxv: 1000 }]),
    } as unknown as Parameters<
      NonNullable<typeof contourGenerator.enrich>
    >[1];
    const out = await contourGenerator.enrich!(
      { field: 'water_level_ft', mode: 'auto', interval: 1 },
      fake,
    );
    expect(out.cachedLevels?.length).toBe(100);
  });

  it('promotes manual levels into cachedLevels unchanged', async () => {
    const fake = {
      sourceSchema: POINT_FIELDS,
      sourceTable: '(SELECT 1) src',
      queryRaw: jest.fn(async () => [] as unknown[]),
    } as unknown as Parameters<
      NonNullable<typeof contourGenerator.enrich>
    >[1];
    const out = await contourGenerator.enrich!(
      {
        field: 'water_level_ft',
        mode: 'manual',
        levels: [42, 55, 73],
      },
      fake,
    );
    expect(out.cachedLevels).toEqual([42, 55, 73]);
  });

  it('handles a source with no rows by stamping an empty level list', async () => {
    const fake = {
      sourceSchema: POINT_FIELDS,
      sourceTable: '(SELECT 1) src',
      queryRaw: jest.fn(async () => [{ minv: null, maxv: null }]),
    } as unknown as Parameters<
      NonNullable<typeof contourGenerator.enrich>
    >[1];
    const out = await contourGenerator.enrich!(
      { field: 'water_level_ft', mode: 'auto', interval: 5 },
      fake,
    );
    expect(out.cachedLevels).toEqual([]);
  });
});

describe('contourGenerator.outputSchema', () => {
  it('replaces upstream attrs with a single `level` number field', () => {
    const out = contourGenerator.outputSchema(POINT_FIELDS, valid());
    expect(out).toEqual([
      {
        name: 'level',
        label: 'Contour level',
        type: 'number',
        nullable: false,
      },
    ]);
  });
});

describe('contourGenerator.outwardReachMeters', () => {
  it('returns 0 because contours stay inside the convex hull', () => {
    expect(contourGenerator.outwardReachMeters(valid())).toBe(0);
  });
});

describe('contourGenerator.extractDependencies', () => {
  it('has no extra item / URL refs', () => {
    expect(contourGenerator.extractDependencies(valid())).toEqual({
      itemIds: [],
      urls: [],
    });
  });
});

describe('contourGenerator.toSql', () => {
  it('returns an empty CTE when there are no cached levels', () => {
    const fragment = contourGenerator.toSql('source', valid(), 0);
    // valid() doesn't carry cachedLevels yet (would be stamped by
    // enrich); empty levels means the WHERE FALSE short-circuit.
    expect(fragment.sql).toMatch(/WHERE FALSE/);
    expect(fragment.params).toEqual([]);
  });

  it('passes cachedLevels as a numeric[] parameter', () => {
    const fragment = contourGenerator.toSql(
      'source',
      { ...valid(), cachedLevels: [10, 20, 30] },
      0,
    );
    expect(fragment.params).toEqual([[10, 20, 30]]);
    expect(fragment.sql).toMatch(/::numeric\[\]/);
    expect(fragment.sql).toMatch(/ST_DelaunayTriangles/);
    expect(fragment.sql).toMatch(/ST_MakeLine/);
  });

  it('honors paramOffset when emitting placeholders', () => {
    const fragment = contourGenerator.toSql(
      'step_2',
      { ...valid(), cachedLevels: [10] },
      5,
    );
    // First placeholder should be $6 ((paramOffset 5) + 1).
    expect(fragment.sql).toMatch(/\$6::numeric\[\]/);
    expect(fragment.sql).toMatch(/FROM step_2/);
  });

  it('emits the level into the output properties', () => {
    const fragment = contourGenerator.toSql(
      'source',
      { ...valid(), cachedLevels: [10] },
      0,
    );
    expect(fragment.sql).toMatch(/jsonb_build_object\('level', level\)/);
  });
});
