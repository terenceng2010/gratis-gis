// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma 7 moved connection management out of schema.prisma and
 * into a Driver Adapter that the application wires into the
 * PrismaClient constructor explicitly. We use @prisma/adapter-pg
 * (node-postgres under the hood, the same driver pg-copy-streams
 * + the engine's COPY writer already speak) so the rest of the
 * stack keeps one connection-management story.
 *
 * `DATABASE_URL` must be present in the environment at module
 * init; the constructor throws loudly if it isn't, matching the
 * pre-7 behaviour where a missing URL surfaced as a Prisma
 * validation error on first query.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        'DATABASE_URL must be set before PrismaService can construct its adapter.',
      );
    }
    super({
      adapter: new PrismaPg({ connectionString: url }),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
