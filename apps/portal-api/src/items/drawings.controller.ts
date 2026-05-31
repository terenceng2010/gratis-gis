// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsHexColor,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { DrawingFeature } from '@gratis-gis/shared-types';

import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  DrawingsService,
  type DrawingsAuthor,
} from './drawings.service.js';

/**
 * Drawings API (#154 Phase 1).
 *
 * All routes scope by map id. Public viewer reads work without
 * authentication when the map is `access='public'` (the service's
 * loadMapForRead handles the gate). Writes require a signed-in
 * user in Phase 1; anonymous create lands in Phase 1.5 once the
 * BFF mints a stable anon-author token cookie.
 */
class DrawingFeatureDto {
  @IsOptional() @IsString() id?: string;
  @IsString() kind!: DrawingFeature['kind'];
  @IsObject() geometry!: unknown;
  @IsOptional() @IsObject() style?: DrawingFeature['style'];
  @IsOptional() @IsString() @MaxLength(500) label?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsString() createdAt?: string;
  @IsOptional() @IsString() updatedAt?: string;
}

class CreateDrawingDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @IsOptional() @IsHexColor() color?: string;
  @IsOptional() @IsArray() features?: DrawingFeatureDto[];
}

class UpdateDrawingDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsHexColor() color?: string;
  @IsOptional() @IsBoolean() visible?: boolean;
  @IsOptional() @IsArray() features?: DrawingFeatureDto[];
}

class AllowAnonymousDto {
  @IsBoolean() allowed!: boolean;
}

@ApiTags('drawings')
@ApiBearerAuth()
@Controller('items/:mapId/drawings')
export class DrawingsController {
  constructor(private readonly drawings: DrawingsService) {}

  /**
   * List every drawing set on a map. Public for public maps.
   * The controller relies on the service to gate non-public reads
   * against canRead.
   */
  @Public()
  @Get()
  list(
    @CurrentUser() user: AuthUser | null,
    @Param('mapId') mapId: string,
  ) {
    if (!isUuid(mapId)) {
      throw new BadRequestException('mapId must be a UUID');
    }
    return this.drawings.list(user, mapId);
  }

  /**
   * Create a new drawing set. Signed-in viewers only in Phase 1.
   */
  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Param('mapId') mapId: string,
    @Body() dto: CreateDrawingDto,
  ) {
    if (!isUuid(mapId)) {
      throw new BadRequestException('mapId must be a UUID');
    }
    const author: DrawingsAuthor = { kind: 'user', user };
    return this.drawings.create(author, mapId, {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.color !== undefined ? { color: dto.color } : {}),
      ...(dto.features !== undefined
        ? { features: dto.features as DrawingFeature[] }
        : {}),
    });
  }

  /**
   * Patch a drawing set. Allowed for the set's author or any
   * editor of the map item.
   */
  @Patch(':drawingId')
  update(
    @CurrentUser() user: AuthUser,
    @Param('mapId') mapId: string,
    @Param('drawingId') drawingId: string,
    @Body() dto: UpdateDrawingDto,
  ) {
    if (!isUuid(mapId)) {
      throw new BadRequestException('mapId must be a UUID');
    }
    if (!isUuid(drawingId)) {
      throw new BadRequestException('drawingId must be a UUID');
    }
    const author: DrawingsAuthor = { kind: 'user', user };
    return this.drawings.update(author, mapId, drawingId, {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.color !== undefined ? { color: dto.color } : {}),
      ...(dto.visible !== undefined ? { visible: dto.visible } : {}),
      ...(dto.features !== undefined
        ? { features: dto.features as DrawingFeature[] }
        : {}),
    });
  }

  /**
   * Delete a drawing set. Same permission posture as update.
   * Idempotent: deleting a non-existent set returns 204 silently.
   */
  @Delete(':drawingId')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('mapId') mapId: string,
    @Param('drawingId') drawingId: string,
  ) {
    if (!isUuid(mapId)) {
      throw new BadRequestException('mapId must be a UUID');
    }
    if (!isUuid(drawingId)) {
      throw new BadRequestException('drawingId must be a UUID');
    }
    const author: DrawingsAuthor = { kind: 'user', user };
    return this.drawings.remove(author, mapId, drawingId);
  }

  /**
   * Toggle the map's `allowAnonymousDrawings` flag. Map editors
   * only. Off by default so a sloppy share doesn't accidentally
   * invite the open internet to draw on a private parcel map.
   */
  @Patch('settings/allow-anonymous')
  allowAnonymous(
    @CurrentUser() user: AuthUser,
    @Param('mapId') mapId: string,
    @Body() dto: AllowAnonymousDto,
  ) {
    if (!isUuid(mapId)) {
      throw new BadRequestException('mapId must be a UUID');
    }
    return this.drawings.setAnonymousDrawingsAllowed(
      user,
      mapId,
      dto.allowed,
    );
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
