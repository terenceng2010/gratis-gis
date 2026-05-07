// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Phase 2.2 acceptance check: write features via DataLayerEngine,
// read them back via the same adapter, verify the v3 wire shape
// (`_global_id`, `_created_by` etc.) is preserved end-to-end against
// a live Postgres.
//
// Run:
//   pnpm -C apps/portal-api data-layer:round-trip
//
// Cleans up its own observations on success.

import { PrismaClient } from '@prisma/client';

import { uuidv7 } from '@gratis-gis/engine';

import { DataLayerEngine } from '../src/engine/data-layer.js';
import { EngineService } from '../src/engine/engine.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

const ITEM_ID = uuidv7();
const LAYER_ID = uuidv7();
const PRINCIPAL = { sub: 'data-layer-round-trip', displayName: 'Round Trip' };
const SOURCE = { kind: 'script:data-layer-round-trip' };

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const engine = new EngineService(prisma as unknown as PrismaService);
  const adapter = new DataLayerEngine(engine, prisma as unknown as PrismaService);

  console.log(`itemId=${ITEM_ID} layerId=${LAYER_ID}`);

  // 1. Create a feature with a client-supplied globalId.
  const explicitId = uuidv7();
  console.log('writing one feature with an explicit globalId...');
  const created = await adapter.writeFeatureCreate({
    itemId: ITEM_ID,
    layerId: LAYER_ID,
    principal: PRINCIPAL,
    source: SOURCE,
    globalId: explicitId,
    properties: { name: 'alpha', count: 1 },
    geometry: { type: 'Point', coordinates: [-111.65, 40.6] },
  });
  if (created.globalId !== explicitId) {
    throw new Error(`expected globalId=${explicitId}, got ${created.globalId}`);
  }
  console.log(`  ok: globalId=${created.globalId}`);

  // 2. Bulk-write nine more.
  console.log('writing 9 features via writeFeaturesCreate...');
  const batch = await adapter.writeFeaturesCreate(
    Array.from({ length: 9 }, (_, i) => ({
      itemId: ITEM_ID,
      layerId: LAYER_ID,
      principal: PRINCIPAL,
      source: SOURCE,
      properties: { name: `point-${i}`, count: i + 2 },
      geometry: { type: 'Point' as const, coordinates: [-111.65 + i * 0.01, 40.6] },
    })),
  );
  console.log(`  ok: ${batch.length} written`);

  // 3. Read them back.
  console.log('reading features...');
  const list = await adapter.listFeatures({ itemId: ITEM_ID, layerId: LAYER_ID });
  if (list.type !== 'FeatureCollection') {
    throw new Error(`expected FeatureCollection, got ${list.type}`);
  }
  if (list.features.length !== 10) {
    throw new Error(`expected 10 features, got ${list.features.length}`);
  }
  for (const f of list.features) {
    if (f.properties._global_id !== f.id) {
      throw new Error(`_global_id mismatch on ${f.id}`);
    }
    if (f.properties._created_by !== PRINCIPAL.sub) {
      throw new Error(`_created_by mismatch on ${f.id}`);
    }
    if (typeof f.properties._created_at !== 'string') {
      throw new Error(`_created_at not a string on ${f.id}`);
    }
  }
  console.log(`  ok: ${list.features.length} features`);

  // 4. Update one feature.
  console.log('updating one feature...');
  await adapter.writeFeatureUpdate({
    itemId: ITEM_ID,
    layerId: LAYER_ID,
    principal: { sub: 'editor-user', displayName: 'Editor' },
    source: SOURCE,
    globalId: explicitId,
    properties: { name: 'alpha-updated', count: 999 },
    geometry: { type: 'Point', coordinates: [-111.7, 40.7] },
  });
  const afterUpdate = await adapter.listFeatures({
    itemId: ITEM_ID,
    layerId: LAYER_ID,
    entity: explicitId,
  });
  if (afterUpdate.features.length !== 1) {
    throw new Error('update read-back returned wrong count');
  }
  const updated = afterUpdate.features[0]!;
  if (updated.properties.name !== 'alpha-updated') {
    throw new Error('update did not change name');
  }
  if (updated.properties._created_by !== PRINCIPAL.sub) {
    throw new Error('_created_by must be the original creator after update');
  }
  if (updated.properties._edited_by !== 'editor-user') {
    throw new Error('_edited_by must be the editor after update');
  }
  console.log('  ok: name=alpha-updated, created_by preserved, edited_by changed');

  // 5. Delete one feature.
  console.log('deleting one feature...');
  await adapter.writeFeatureDelete({
    itemId: ITEM_ID,
    layerId: LAYER_ID,
    principal: PRINCIPAL,
    source: SOURCE,
    globalId: explicitId,
  });
  const afterDelete = await adapter.listFeatures({ itemId: ITEM_ID, layerId: LAYER_ID });
  if (afterDelete.features.length !== 9) {
    throw new Error(`expected 9 features after delete, got ${afterDelete.features.length}`);
  }
  console.log(`  ok: ${afterDelete.features.length} features visible`);

  // 6. ownRowsOnly filter.
  console.log('verifying ownRowsOnly filter...');
  const otherUserView = await adapter.listFeatures({
    itemId: ITEM_ID,
    layerId: LAYER_ID,
    ownRowsOnly: { userId: 'someone-else' },
  });
  if (otherUserView.features.length !== 0) {
    throw new Error(
      `ownRowsOnly filter broke: expected 0 features for someone-else, got ${otherUserView.features.length}`,
    );
  }
  console.log('  ok: someone-else sees 0 features');

  // 7. bbox filter.
  console.log('verifying bbox filter...');
  const tinyBox = await adapter.listFeatures({
    itemId: ITEM_ID,
    layerId: LAYER_ID,
    bbox: [-111.66, 40.59, -111.65, 40.61],
  });
  if (tinyBox.features.length === 0) {
    throw new Error('bbox filter returned no rows; some should match');
  }
  if (tinyBox.features.length === 9) {
    throw new Error('bbox filter matched everything; should be a strict subset');
  }
  console.log(`  ok: bbox filter matched ${tinyBox.features.length} of 9 features`);

  // Cleanup.
  console.log('cleaning up...');
  await prisma.$executeRaw`
    DELETE FROM observation
    WHERE scope = ${`data_layer:${ITEM_ID}:${LAYER_ID}`}
  `;
  await prisma.$disconnect();

  console.log('OK');
}

main().catch(async (err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
