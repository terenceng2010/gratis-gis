// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { OsmSaveAsLayerService } from './save-as-layer.service.js';
import type { OsmGeoJsonFeature } from './osm-to-geojson.js';

class OsmSaveFeatureDto {
  @IsString()
  id!: string;

  @IsString()
  type!: 'Feature';

  @IsObject()
  geometry!: unknown;

  @IsObject()
  properties!: Record<string, unknown>;
}

class OsmSaveAsLayerBodyDto {
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsArray()
  // Same cap as OsmService.resolve's maxFeatures default. Anything
  // larger arriving here would already have been truncated upstream
  // by the resolver, so a request with > 50k features is a sign of
  // a tampered client and we reject it loudly.
  @ArrayMinSize(1)
  @ArrayMaxSize(50000)
  @ValidateNested({ each: true })
  @Type(() => OsmSaveFeatureDto)
  features!: OsmSaveFeatureDto[];
}

/**
 * OSM "Save overlay as data_layer" endpoint (#102).
 *
 * Lives under /osm so it sits next to the other OSM surfaces
 * (the preset catalog is public; this one is authenticated because
 * it creates an item the user owns). The controller is a thin
 * delegation layer over OsmSaveAsLayerService; all the schema
 * inference and provisioning logic stays in the service for
 * unit-testability.
 */
@ApiTags('osm')
@ApiBearerAuth()
@Controller('osm')
export class OsmSaveAsLayerController {
  constructor(private readonly svc: OsmSaveAsLayerService) {}

  @Post('save-as-data-layer')
  async saveAsDataLayer(
    @CurrentUser() user: AuthUser,
    @Body() body: OsmSaveAsLayerBodyDto,
  ): Promise<{ itemId: string; layerId: string; inserted: number }> {
    if (!user) {
      // Defense in depth: the JWT guard at the app level should
      // already reject anonymous; this surfaces a clear message
      // rather than letting it fall through to a NaN-style error
      // inside the service.
      throw new BadRequestException('Authentication required.');
    }
    return this.svc.saveOverlayAsLayer({
      user,
      title: body.title,
      ...(body.description !== undefined ? { description: body.description } : {}),
      features: body.features as unknown as OsmGeoJsonFeature[],
    });
  }
}
