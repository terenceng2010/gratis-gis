// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Observation, isUuid, uuidv7 } from '@gratis-gis/engine';

import {
  DataLayerEngine,
  dataLayerScope,
  type CreateFeatureArgs,
  type DeleteFeatureArgs,
  type UpdateFeatureArgs,
} from './data-layer.js';
import type { EngineService } from './engine.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const PRINCIPAL = { sub: 'user-1', displayName: 'User One' };
const ITEM_ID = '11111111-1111-7111-8111-111111111111';
const LAYER_ID = '22222222-2222-7222-8222-222222222222';

/**
 * Capture-and-return fake EngineService. `write` and `writeMany` echo
 * back inputs with `id`, `txTime`, and `cell` filled in so callers can
 * assert the full Observation shape that the adapter produced.
 */
function makeFakeEngine() {
  const writes: Observation[] = [];
  const fillBookkeeping = (input: Observation): Observation => ({
    ...input,
    id: input.id ?? uuidv7(),
    txTime: input.txTime ?? new Date(),
    cell: input.cell ?? null,
  });
  return {
    writes,
    fake: {
      async write(input: Observation): Promise<Observation> {
        const filled = fillBookkeeping(input);
        writes.push(filled);
        return filled;
      },
      async writeMany(inputs: Observation[]): Promise<Observation[]> {
        const filled = inputs.map(fillBookkeeping);
        writes.push(...filled);
        return filled;
      },
    } as unknown as EngineService,
  };
}

/**
 * Fake PrismaService whose `$queryRaw` returns whatever the test
 * loaded into `rows`. listFeatures issues a single combined query;
 * tests load the expected shape directly.
 */
interface FakeFeatureRow {
  entity: string;
  observation_id: string;
  attrs: Record<string, unknown> | null;
  geom_geojson: unknown;
  edited_by: string;
  edited_at: Date;
  created_by: string;
  created_at: Date;
}
function makeFakePrisma() {
  let rows: FakeFeatureRow[] = [];
  return {
    setRows(next: FakeFeatureRow[]) {
      rows = next;
    },
    fake: {
      async $queryRaw() {
        return rows;
      },
    } as unknown as PrismaService,
  };
}

function createArgs(overrides: Partial<CreateFeatureArgs> = {}): CreateFeatureArgs {
  return {
    itemId: ITEM_ID,
    layerId: LAYER_ID,
    principal: PRINCIPAL,
    properties: { name: 'feature-a', value: 42 },
    geometry: { type: 'Point', coordinates: [-111.65, 40.6] },
    ...overrides,
  };
}

function updateArgs(overrides: Partial<UpdateFeatureArgs> = {}): UpdateFeatureArgs {
  return {
    itemId: ITEM_ID,
    layerId: LAYER_ID,
    principal: PRINCIPAL,
    globalId: uuidv7(),
    properties: { name: 'updated' },
    ...overrides,
  };
}

function deleteArgs(overrides: Partial<DeleteFeatureArgs> = {}): DeleteFeatureArgs {
  return {
    itemId: ITEM_ID,
    layerId: LAYER_ID,
    principal: PRINCIPAL,
    globalId: uuidv7(),
    ...overrides,
  };
}

describe('dataLayerScope', () => {
  it('encodes (itemId, layerId) into a canonical scope string', () => {
    expect(dataLayerScope('item-x', 'layer-y')).toBe('data_layer:item-x:layer-y');
  });
});

describe('DataLayerEngine.writeFeatureCreate', () => {
  it('writes a kind=create observation with a fresh entity id', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake);

    const result = await adapter.writeFeatureCreate(createArgs());

    expect(engine.writes).toHaveLength(1);
    const obs = engine.writes[0]!;
    expect(obs.kind).toBe('create');
    expect(obs.scope).toBe(dataLayerScope(ITEM_ID, LAYER_ID));
    expect(isUuid(obs.entity)).toBe(true);
    expect(result.globalId).toBe(obs.entity);
    expect(isUuid(result.observationId)).toBe(true);
  });

  it('passes properties through as attrs and geometry through as geom', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake);

    await adapter.writeFeatureCreate(createArgs());

    const obs = engine.writes[0]!;
    expect(obs.attrs).toEqual({ name: 'feature-a', value: 42 });
    expect(obs.geom).toEqual({ type: 'Point', coordinates: [-111.65, 40.6] });
  });

  it('defaults source.kind to data_layer:write when not given', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake);

    await adapter.writeFeatureCreate(createArgs());

    expect(engine.writes[0]!.source.kind).toBe('data_layer:write');
  });

  it('respects an explicit source override', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake);

    await adapter.writeFeatureCreate(
      createArgs({ source: { kind: 'ingest:shapefile' } }),
    );

    expect(engine.writes[0]!.source.kind).toBe('ingest:shapefile');
  });

  it('handles missing properties and geometry as null', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake);

    await adapter.writeFeatureCreate({
      itemId: ITEM_ID,
      layerId: LAYER_ID,
      principal: PRINCIPAL,
    });

    const obs = engine.writes[0]!;
    expect(obs.attrs).toBe(null);
    expect(obs.geom).toBe(null);
  });

  it('uses an explicit globalId as the entity id when provided', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake);
    const globalId = uuidv7();

    const result = await adapter.writeFeatureCreate(createArgs({ globalId }));

    expect(engine.writes[0]!.entity).toBe(globalId);
    expect(result.globalId).toBe(globalId);
  });
});

describe('DataLayerEngine.writeFeaturesCreate', () => {
  it('returns an empty array on empty input', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake);

    const out = await adapter.writeFeaturesCreate([]);
    expect(out).toEqual([]);
    expect(engine.writes).toHaveLength(0);
  });

  it('writes one create observation per input and returns aligned ids', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake);

    const inputs = [
      createArgs({ properties: { i: 0 } }),
      createArgs({ properties: { i: 1 } }),
      createArgs({ properties: { i: 2 } }),
    ];
    const out = await adapter.writeFeaturesCreate(inputs);

    expect(out).toHaveLength(3);
    expect(engine.writes).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(engine.writes[i]!.kind).toBe('create');
      expect(isUuid(engine.writes[i]!.entity)).toBe(true);
      expect(out[i]!.globalId).toBe(engine.writes[i]!.entity);
      expect((engine.writes[i]!.attrs as { i: number }).i).toBe(i);
    }
  });

  it('every entity id is unique', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake);

    const inputs = Array.from({ length: 20 }, () => createArgs());
    const out = await adapter.writeFeaturesCreate(inputs);
    const ids = new Set(out.map((r) => r.globalId));
    expect(ids.size).toBe(20);
  });

  it('honors per-input globalId when provided, generates fresh ones otherwise', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake);
    const supplied = uuidv7();

    const out = await adapter.writeFeaturesCreate([
      createArgs({ globalId: supplied }),
      createArgs(), // no globalId, should get a fresh one
    ]);

    expect(out[0]!.globalId).toBe(supplied);
    expect(isUuid(out[1]!.globalId)).toBe(true);
    expect(out[1]!.globalId).not.toBe(supplied);
  });
});

describe('DataLayerEngine.writeFeatureUpdate', () => {
  it('writes a kind=update observation that preserves the entity id', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake);
    const args = updateArgs();

    await adapter.writeFeatureUpdate(args);

    const obs = engine.writes[0]!;
    expect(obs.kind).toBe('update');
    expect(obs.entity).toBe(args.globalId);
    expect(obs.attrs).toEqual({ name: 'updated' });
  });
});

describe('DataLayerEngine.writeFeatureDelete', () => {
  it('writes a kind=delete observation with null attrs and geom', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake);
    const args = deleteArgs();

    await adapter.writeFeatureDelete(args);

    const obs = engine.writes[0]!;
    expect(obs.kind).toBe('delete');
    expect(obs.entity).toBe(args.globalId);
    expect(obs.attrs).toBe(null);
    expect(obs.geom).toBe(null);
  });
});

describe('DataLayerEngine.listFeatures', () => {
  function row(
    entity: string,
    overrides: Partial<FakeFeatureRow> = {},
  ): FakeFeatureRow {
    return {
      entity,
      observation_id: uuidv7(),
      attrs: { name: 'feature-a' },
      geom_geojson: { type: 'Point', coordinates: [-111.65, 40.6] },
      edited_by: 'editor-user',
      edited_at: new Date('2026-04-01T00:00:00Z'),
      created_by: 'creator-user',
      created_at: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    };
  }

  it('returns an empty FeatureCollection when the query returns no rows', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake);
    prisma.setRows([]);

    const out = await adapter.listFeatures({ itemId: ITEM_ID, layerId: LAYER_ID });
    expect(out).toEqual({ type: 'FeatureCollection', features: [] });
  });

  it('returns a FeatureCollection with surfaced editor tracking', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake);
    const entity = uuidv7();
    prisma.setRows([row(entity)]);

    const out = await adapter.listFeatures({ itemId: ITEM_ID, layerId: LAYER_ID });
    expect(out.type).toBe('FeatureCollection');
    expect(out.features).toHaveLength(1);
    const feat = out.features[0]!;
    expect(feat.id).toBe(entity);
    expect(feat.geometry).toEqual({
      type: 'Point',
      coordinates: [-111.65, 40.6],
    });
    expect(feat.properties._global_id).toBe(entity);
    expect(feat.properties._created_by).toBe('creator-user');
    expect(feat.properties._created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(feat.properties._edited_by).toBe('editor-user');
    expect(feat.properties._edited_at).toBe('2026-04-01T00:00:00.000Z');
    expect(feat.properties.name).toBe('feature-a');
  });

  it('passes through null geometry and null attrs without crashing', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake);
    const entity = uuidv7();
    prisma.setRows([row(entity, { attrs: null, geom_geojson: null })]);

    const out = await adapter.listFeatures({ itemId: ITEM_ID, layerId: LAYER_ID });
    expect(out.features[0]!.geometry).toBe(null);
    expect(out.features[0]!.properties._global_id).toBe(entity);
  });

  it('honors a limit override', async () => {
    const engine = makeFakeEngine();
    const prisma = makeFakePrisma();
    const adapter = new DataLayerEngine(engine.fake, prisma.fake);
    prisma.setRows([row(uuidv7())]);

    // Just verify the call shape; the SQL contains LIMIT but we are
    // not asserting on raw SQL here because the fake $queryRaw does
    // not capture the template strings. The SQL composition is
    // exercised end-to-end by the integration round-trip script.
    const out = await adapter.listFeatures({
      itemId: ITEM_ID,
      layerId: LAYER_ID,
      limit: 50,
    });
    expect(out.features).toHaveLength(1);
  });
});
