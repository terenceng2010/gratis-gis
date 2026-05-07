// SPDX-License-Identifier: AGPL-3.0-or-later
// Diagnostic: write one observation, read it back, dump the wire shape.
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from '@gratis-gis/engine';
import { DataLayerEngine } from '../src/engine/data-layer.js';
import { EngineService } from '../src/engine/engine.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

const ITEM_ID = uuidv7();
const LAYER_ID = uuidv7();

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const engine = new EngineService(prisma as unknown as PrismaService);
  const adapter = new DataLayerEngine(engine, prisma as unknown as PrismaService);

  await adapter.writeFeatureCreate({
    itemId: ITEM_ID,
    layerId: LAYER_ID,
    principal: { sub: 'diag', displayName: 'd' },
    properties: { name: 'pt' },
    geometry: { type: 'Point', coordinates: [-111.65, 40.6] },
  });

  const out = await adapter.listFeatures({ itemId: ITEM_ID, layerId: LAYER_ID });
  console.log('--- raw return ---');
  console.log(JSON.stringify(out, null, 2));
  console.log('--- typeof geometry ---');
  for (const f of out.features) {
    console.log('id:', f.id);
    console.log('geometry type:', typeof f.geometry, Array.isArray(f.geometry));
    console.log('geometry value:', JSON.stringify(f.geometry));
    console.log('geometry.type:', (f.geometry as { type?: unknown })?.type);
    console.log(
      'geometry.coordinates:',
      JSON.stringify((f.geometry as { coordinates?: unknown })?.coordinates),
    );
  }

  await prisma.$executeRaw`DELETE FROM observation WHERE scope = ${`data_layer:${ITEM_ID}:${LAYER_ID}`}`;
  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
