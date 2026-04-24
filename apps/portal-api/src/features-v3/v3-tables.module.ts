import { Module } from '@nestjs/common';

import { V3TablesService } from './v3-tables.service.js';

/**
 * Dependency-free (besides PrismaService) module for v3 layer table
 * lifecycle. ItemsModule imports this to reconcile tables on item
 * create / update / purge without the full feature CRUD surface.
 */
@Module({
  providers: [V3TablesService],
  exports: [V3TablesService],
})
export class V3TablesModule {}
