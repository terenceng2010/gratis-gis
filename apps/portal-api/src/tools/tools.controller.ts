// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { IsObject, IsOptional, IsUUID } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  RecipeRunnerService,
  type ToolRunRequest,
} from './recipe-runner.service.js';

/**
 * Wire-shape for POST /api/tools/:id/run.  The parameter map is left
 * as a free-form object since each recipe declares its own slots;
 * the runner validates every name against the recipe's parameter
 * schema before doing anything.
 */
class ToolRunDto {
  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;
}

/**
 * Tool recipe HTTP surface (#90).  POST /api/tools/:id/run executes
 * the tool's recipe against the caller's authorisation and returns
 * the output sink shape (selection feature ids in v1; derived-layer
 * / data-layer outputs land in follow-up commits).
 *
 * The endpoint is gated by the global JwtAuthGuard.  The runner
 * gates on read access to the tool itself AND to the target layer
 * referenced by the output -- a user must hold read on every layer
 * the recipe touches, not just the tool.
 */
@ApiTags('tools')
@ApiBearerAuth()
@Controller('tools')
export class ToolsController {
  constructor(private readonly runner: RecipeRunnerService) {}

  @Post(':id/run')
  @HttpCode(200)
  async run(
    @CurrentUser() user: AuthUser,
    @Param('id') toolId: string,
    @Body() body: ToolRunDto,
  ) {
    const request: ToolRunRequest = {
      parameters: (body.parameters ?? {}) as ToolRunRequest['parameters'],
    };
    // run() branches internally on the recipe's output sink: a
    // selection-output recipe lands the old shape; an
    // osm-features-overlay recipe lands the new shape.  The wire
    // contract is the same `parameters` envelope; only the
    // response shape differs.
    return this.runner.run(user, toolId, request);
  }
}
