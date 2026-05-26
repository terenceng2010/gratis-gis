// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Prisma 7 config. Prisma 7 moved the connection URL out of
// schema.prisma and into this file for the CLI / migrate
// workflow. The runtime PrismaClient constructor reads its
// connection separately via a Driver Adapter (see
// src/prisma/prisma.service.ts).
//
// The schema and migrations directories are explicit so we can
// invoke `pnpm prisma migrate dev` from the repo root or from
// inside apps/portal-api without surprises.

import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Prisma 7 needs the connection string in the environment for migrate / pull / push commands.',
  );
}

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  datasource: {
    url: databaseUrl,
  },
});
