// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Phase 1 acceptance check for the observation-log engine.
//
// Writes 10 observations to a fresh test scope, reads them back as
// GeoJSON features, and asserts both the count and a few field-level
// invariants (cells populated, bookkeeping shapes, geometry round-trip
// preserved). Prints a summary and exits non-zero on any failure.
//
// Run:
//   pnpm -C apps/portal-api engine:round-trip
//
// Requires:
//   - infra up (`pnpm infra:up` from the repo root)
//   - migrations applied (`pnpm -C apps/portal-api prisma migrate deploy`
//     or run the api once; it deploys on boot)
//
// The script writes to a uniquely-named scope per run, so it leaves no
// permanent footprint on top of normal dev data. It does drop its own
// rows on success.

import { PrismaClient } from '@prisma/client';

import { type Observation, uuidv7 } from '@gratis-gis/engine';

import { EngineService } from '../src/engine/engine.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

const SCOPE = `data_layer:engine-round-trip-${uuidv7()}`;
const PRINCIPAL = { sub: 'engine-round-trip', displayName: 'Round Trip' };
const SOURCE = { kind: 'script:engine-round-trip' };

function fixturePoint(i: number): Observation {
  // 10 evenly-spaced points along a line east of Park City, UT.
  // Far enough apart that some land in different H3 res-7 cells.
  const lng = -111.65 + i * 0.05;
  const lat = 40.6 + i * 0.02;
  return {
    validFrom: new Date(),
    validTo: null,
    scope: SCOPE,
    entity: uuidv7(),
    kind: 'create',
    attrs: { idx: i, label: `point-${i}` },
    geom: { type: 'Point', coordinates: [lng, lat] },
    author: PRINCIPAL,
    source: SOURCE,
    parents: [],
  };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const engine = new EngineService(prisma as unknown as PrismaService);

  console.log(`scope = ${SCOPE}`);
  console.log('writing 10 observations...');
  const written: Observation[] = [];
  for (let i = 0; i < 10; i++) {
    const obs = await engine.write(fixturePoint(i));
    written.push(obs);
  }
  console.log(`  ok: ${written.length} written`);

  console.log('reading back as features...');
  const features = await engine.read({ scope: SCOPE });
  console.log(`  ok: ${features.length} features`);

  // Invariants.
  const errors: string[] = [];
  if (features.length !== 10) {
    errors.push(`expected 10 features, got ${features.length}`);
  }
  for (const obs of written) {
    const match = features.find((f) => f.id === obs.entity);
    if (!match) {
      errors.push(`entity ${obs.entity} missing from read result`);
      continue;
    }
    if (match.geometry?.type !== 'Point') {
      errors.push(`entity ${obs.entity} geometry not a Point`);
    }
    if ((match.properties as { idx?: number }).idx === undefined) {
      errors.push(`entity ${obs.entity} attrs not preserved`);
    }
    const meta = match.properties.__engine;
    if (!meta || typeof meta.observationId !== 'string') {
      errors.push(`entity ${obs.entity} missing __engine bookkeeping`);
    }
  }
  for (const obs of written) {
    if (typeof obs.cell !== 'string' || obs.cell.length !== 15) {
      errors.push(`written obs ${obs.id} cell missing or wrong shape`);
    }
  }

  if (errors.length > 0) {
    console.error('FAIL');
    for (const err of errors) console.error(`  - ${err}`);
    await prisma.$disconnect();
    process.exit(1);
  }

  // Clean up after ourselves on success. On failure we leave rows so
  // they can be inspected.
  console.log('cleaning up...');
  await prisma.$executeRaw`DELETE FROM observation WHERE scope = ${SCOPE}`;
  await prisma.$disconnect();

  console.log('OK');
}

main().catch(async (err) => {
  console.error('FAIL (uncaught):', err);
  process.exit(1);
});
