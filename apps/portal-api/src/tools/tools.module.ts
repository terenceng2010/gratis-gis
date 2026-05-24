// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { ItemsModule } from '../items/items.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { RecipeRunnerService } from './recipe-runner.service.js';
import { ToolsController } from './tools.controller.js';

/**
 * Wires the Tool item v2 runtime: a controller exposing
 * POST /api/tools/:id/run plus the RecipeRunnerService that
 * resolves runtime parameters, substitutes them into the recipe
 * pipeline, and executes the SQL.  Depends on the ItemsModule for
 * ACL-gated reads of the tool item and any referenced layers, and
 * on PrismaModule for the raw SQL hop.
 */
@Module({
  imports: [ItemsModule, PrismaModule],
  controllers: [ToolsController],
  providers: [RecipeRunnerService],
})
export class ToolsModule {}
