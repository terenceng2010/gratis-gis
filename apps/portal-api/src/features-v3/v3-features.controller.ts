import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import { V3FeaturesService } from './v3-features.service.js';

class AppendFeatureDto {
  @IsOptional() @IsString() globalId?: string;
  @IsOptional() @IsObject() geometry?: unknown;
  @IsOptional() @IsObject() properties?: Record<string, unknown>;
}

class AppendFeaturesBodyDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AppendFeatureDto)
  features!: AppendFeatureDto[];
}

class UpdateFeatureBodyDto {
  @IsOptional() @IsObject() geometry?: unknown;
  @IsOptional() @IsObject() properties?: Record<string, unknown>;
}

/**
 * Per-layer feature CRUD for v3 feature_service items.
 *
 * Routes sit under /items/:id/layers/:layerId/... so they live
 * alongside the item-level routes but don't collide with v1/v2's
 * /items/:id/features endpoints.
 *
 * Auth: ItemsService.get() is called at the start of each handler to
 * enforce visibility (throws 403/404 as needed); sharing rights drive
 * read vs write gating via canEdit().
 */
@ApiTags('features', 'v3')
@ApiBearerAuth()
@Controller('items/:id/layers/:layerId')
export class V3FeaturesController {
  constructor(
    private readonly items: ItemsService,
    private readonly v3: V3FeaturesService,
  ) {}

  @Get('features')
  async listFeatures(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Query('bbox') bbox?: string,
    @Query('at') at?: string,
  ) {
    await this.assertV3Layer(user, itemId, layerId, 'read');
    const opts: { bbox?: [number, number, number, number]; at?: string } = {};
    if (bbox) {
      const parts = bbox.split(',').map(Number);
      if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
        opts.bbox = [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
      }
    }
    if (at) opts.at = at;
    return this.v3.listFeatures(itemId, layerId, opts);
  }

  /** GeoJSON view of a single layer — the map editor's overlay source
   *  hits this per-layer URL for v3 items, the same way v2 items use
   *  /items/:id/geojson. */
  @Get('geojson')
  async geojson(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Query('bbox') bbox?: string,
    @Query('at') at?: string,
  ) {
    return this.listFeatures(user, itemId, layerId, bbox, at);
  }

  @Post('features')
  async append(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Body() body: AppendFeaturesBodyDto,
  ) {
    await this.assertV3Layer(user, itemId, layerId, 'write');
    return this.v3.insertFeatures(itemId, layerId, body.features, user);
  }

  @Patch('features/:fid')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Param('fid') featureId: string,
    @Body() body: UpdateFeatureBodyDto,
  ) {
    await this.assertV3Layer(user, itemId, layerId, 'write');
    const patch: { geometry?: unknown; properties?: Record<string, unknown> } = {};
    if (body.geometry !== undefined) patch.geometry = body.geometry;
    if (body.properties !== undefined) patch.properties = body.properties;
    return this.v3.updateFeature(itemId, layerId, featureId, patch, user);
  }

  @Delete('features/:fid')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @Param('fid') featureId: string,
  ) {
    await this.assertV3Layer(user, itemId, layerId, 'write');
    await this.v3.deleteFeature(itemId, layerId, featureId, user);
  }

  /** Verify the item exists, is a v3 feature_service, the caller can
   *  read (or edit) it, and the named layer is part of its schema. */
  private async assertV3Layer(
    user: AuthUser,
    itemId: string,
    layerId: string,
    mode: 'read' | 'write',
  ): Promise<void> {
    const item = await this.items.get(user, itemId);
    if (item.type !== 'feature_service') {
      throw new NotFoundException('Not a feature_service item');
    }
    const data = item.data as {
      version?: number;
      layers?: Array<{ id: string }>;
    } | null;
    if (data?.version !== 3) {
      throw new NotFoundException(
        'Item is not a v3 multi-layer feature_service',
      );
    }
    const layerExists = (data.layers ?? []).some((l) => l.id === layerId);
    if (!layerExists) {
      throw new NotFoundException(
        `Layer ${layerId} is not part of this item's schema`,
      );
    }
    if (mode === 'write') {
      // Authoritative edit gate: same helper update() uses.
      await this.items.assertCanEdit(user, itemId);
    }
  }
}
