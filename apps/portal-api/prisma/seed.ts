/**
 * Dev seed. Mirrors the Keycloak realm seed: org `acme` with Alice (publisher)
 * and Bob (admin), plus a group and a couple of example items.
 *
 * Run: `pnpm --filter @gratis-gis/portal-api db:seed`
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ACME_ID = '11111111-1111-1111-1111-111111111111';
const ALICE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOB_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const GROUP_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

async function main() {
  console.log('→ seeding organization');
  const org = await prisma.organization.upsert({
    where: { id: ACME_ID },
    update: {},
    create: { id: ACME_ID, slug: 'acme', name: 'Acme Corp' },
  });

  console.log('→ seeding users');
  await prisma.user.upsert({
    where: { id: ALICE_ID },
    update: {},
    create: {
      id: ALICE_ID,
      orgId: org.id,
      username: 'alice',
      email: 'alice@acme.test',
      fullName: 'Alice Example',
      orgRole: 'publisher',
    },
  });
  await prisma.user.upsert({
    where: { id: BOB_ID },
    update: {},
    create: {
      id: BOB_ID,
      orgId: org.id,
      username: 'bob',
      email: 'bob@acme.test',
      fullName: 'Bob Example',
      orgRole: 'admin',
    },
  });

  console.log('→ seeding group');
  await prisma.group.upsert({
    where: { id: GROUP_ID },
    update: {},
    create: {
      id: GROUP_ID,
      orgId: org.id,
      title: 'Field Team',
      description: 'Members collecting field data for Acme.',
      access: 'org',
      ownerId: BOB_ID,
    },
  });
  await prisma.groupMember.upsert({
    where: { groupId_userId: { groupId: GROUP_ID, userId: ALICE_ID } },
    update: {},
    create: { groupId: GROUP_ID, userId: ALICE_ID, role: 'member' },
  });
  await prisma.groupMember.upsert({
    where: { groupId_userId: { groupId: GROUP_ID, userId: BOB_ID } },
    update: {},
    create: { groupId: GROUP_ID, userId: BOB_ID, role: 'admin' },
  });

  console.log('→ seeding items');
  await prisma.item.create({
    data: {
      orgId: org.id,
      ownerId: ALICE_ID,
      type: 'web_map',
      title: 'Acme HQ Campus Map',
      description: 'Basemap + building outlines, shared to the Field Team.',
      tags: ['campus', 'buildings'],
      dataJson: {
        basemap: 'osm-bright',
        initialExtent: { xmin: -122.45, ymin: 37.77, xmax: -122.40, ymax: 37.80 },
        layers: [],
      },
      access: 'private',
    },
  });

  console.log('✓ seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
