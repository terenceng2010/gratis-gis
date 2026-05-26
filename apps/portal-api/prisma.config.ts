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

// DATABASE_URL is read at config-load time but not required for
// every Prisma operation. `prisma generate` only emits the client
// from the schema and never touches the database; `migrate`,
// `pull`, `push`, etc. do need it and Prisma will surface its own
// "no database URL" error at those touchpoints. By passing
// `undefined` here when DATABASE_URL is absent we let `generate`
// succeed (which matters during the Docker build phase where the
// container has no DB connection yet) while the runtime + migrate
// paths still fail loudly if the env-var is missing later.
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  ...(databaseUrl
    ? { datasource: { url: databaseUrl } }
    : {}),
});
