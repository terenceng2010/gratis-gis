// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ObservationValidationError,
  type Observation,
  isUuid,
  uuidv7,
} from '@gratis-gis/engine';

import { EngineService } from './engine.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Minimal fake PrismaService that records `$executeRaw` and `$queryRaw`
 * tagged-template invocations without touching a real database.
 */
function makeFakePrisma() {
  const writes: Array<{ values: unknown[] }> = [];
  return {
    writes,
    fake: {
      async $executeRaw(_strings: TemplateStringsArray, ...values: unknown[]) {
        writes.push({ values });
        return 1;
      },
      async $queryRaw(_strings: TemplateStringsArray, ..._values: unknown[]) {
        return [];
      },
    } as unknown as PrismaService,
  };
}

function fixture(overrides: Partial<Observation> = {}): Observation {
  return {
    validFrom: new Date('2026-01-01T00:00:00Z'),
    validTo: null,
    scope: 'data_layer:test',
    entity: uuidv7(),
    kind: 'create',
    attrs: { name: 'test' },
    geom: { type: 'Point', coordinates: [-111.65, 40.6] },
    author: { sub: 'user-123', displayName: 'Test User' },
    source: { kind: 'web' },
    parents: [],
    ...overrides,
  };
}

describe('EngineService.write', () => {
  it('fills in id, txTime, and cell when omitted', async () => {
    const { fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    const obs = await svc.write(fixture());
    expect(isUuid(obs.id ?? '')).toBe(true);
    expect(obs.txTime).toBeInstanceOf(Date);
    expect(obs.cell).toMatch(/^[0-9a-f]+$/);
  });

  it('preserves explicit id, txTime, and cell when provided', async () => {
    const { fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    const id = uuidv7();
    const txTime = new Date('2026-02-02T00:00:00Z');
    const obs = await svc.write(fixture({ id, txTime, cell: '871fb466cffffff' }));
    expect(obs.id).toBe(id);
    expect(obs.txTime).toEqual(txTime);
    expect(obs.cell).toBe('871fb466cffffff');
  });

  it('rejects observations that fail validation', async () => {
    const { fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    await expect(
      svc.write(fixture({ entity: 'not-a-uuid' })),
    ).rejects.toBeInstanceOf(ObservationValidationError);
  });

  it('omits the cell when the geometry is null', async () => {
    const { fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    const obs = await svc.write(fixture({ geom: null }));
    expect(obs.cell).toBe(null);
  });

  it('issues exactly one $executeRaw call per write', async () => {
    const { writes, fake } = makeFakePrisma();
    const svc = new EngineService(fake);
    await svc.write(fixture());
    expect(writes).toHaveLength(1);
  });
});
