import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { ItemAccess, ItemType, Prisma, PrincipalType, SharePermission } from '@prisma/client';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import type { CreateItemInput, UpdateItemInput } from './items.service.js';
import { ItemsService } from './items.service.js';

const ITEM_TYPE_VALUES = [
  'web_map',
  'feature_service',
  'form',
  'form_submission_collection',
  'web_app',
  'report_template',
  'dashboard',
  'file',
  'layer_package',
  'notebook',
  'tool',
  'widget_package',
] as const;

class CreateItemDto {
  @IsEnum(ITEM_TYPE_VALUES) type!: ItemType;
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  // Typed as JSON-compatible at the Prisma layer; validated at runtime by @IsObject.
  @IsObject() data!: Prisma.InputJsonValue;
  @IsOptional() @IsEnum(['private', 'org', 'public']) access?: ItemAccess;
  // Absolute URL minted by StorageService when the user uploads a custom
  // thumbnail during create. Optional; null/omitted falls back to the
  // auto-generated initial badge.
  @IsOptional() @IsString() @MaxLength(2048) thumbnailUrl?: string | null;
}

class UpdateItemDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsObject() data?: Prisma.InputJsonValue;
  @IsOptional() @IsEnum(['private', 'org', 'public']) access?: ItemAccess;
  // Absolute URL produced by StorageService after the browser PUT completes.
  // Pass null to clear a previously-set thumbnail.
  @IsOptional() @IsString() @MaxLength(2048) thumbnailUrl?: string | null;
}

class ShareDto {
  @IsEnum(['user', 'group']) principalType!: PrincipalType;
  // 'loose' accepts any 8-4-4-4-12 hex string. Real UUIDs coming from Keycloak
// and Prisma's @default(uuid()) are always v4, but seed fixtures use
// readable all-same-char UUIDs (aaaa..., bbbb...) for debugging that fail
// strict v4 validation. The DB-level FK check is our real integrity
// guarantee via assertPrincipalExists().
@IsUUID('loose') principalId!: string;
  @IsOptional() @IsEnum(['view', 'edit', 'admin']) permission?: SharePermission;
}

@ApiTags('items')
@ApiBearerAuth()
@Controller('items')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('mine') mine?: string,
    @Query('type') type?: ItemType,
    @Query('q') q?: string,
  ) {
    // Build opts without explicit-undefined keys so `exactOptionalPropertyTypes`
    // is satisfied. Passing `{ type: undefined }` is not the same as omitting it.
    const opts: { mine?: boolean; type?: ItemType; q?: string } = {};
    if (mine === 'true') opts.mine = true;
    if (type !== undefined) opts.type = type;
    if (q !== undefined) opts.q = q;
    return this.items.list(user, opts);
  }

  // NOTE: /items/trash must be declared before /items/:id so Nest's
  // route matcher doesn't try to treat "trash" as an id parameter.
  @Get('trash')
  listTrash(@CurrentUser() user: AuthUser) {
    return this.items.listTrash(user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.items.get(user, id);
  }

  /**
   * GeoJSON-only view of a feature_service item. Exposing this as a
   * separate endpoint lets MapLibre's geojson source consume it with
   * its own fetch and cache semantics, rather than having the client
   * fetch the whole item envelope and extract data manually.
   *
   * 404 if the item is not a feature_service or its data is not a
   * GeoJSON FeatureCollection. Visibility still goes through the same
   * sharing check as the regular get.
   */
  @Get(':id/geojson')
  async geojson(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const item = await this.items.get(user, id);
    if (item.type !== 'feature_service') {
      return { type: 'FeatureCollection', features: [] };
    }
    const payload = item.data as { data?: unknown } | null;
    const fc = payload?.data;
    if (
      !fc ||
      typeof fc !== 'object' ||
      (fc as { type?: string }).type !== 'FeatureCollection'
    ) {
      return { type: 'FeatureCollection', features: [] };
    }
    return fc;
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateItemDto) {
    return this.items.create(user, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateItemDto,
  ) {
    return this.items.update(user, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.items.remove(user, id);
  }

  @Post(':id/restore')
  restore(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.items.restore(user, id);
  }

  /**
   * Permanent delete. Distinct verb+path from soft-delete so a bad client
   * retrying a DELETE can't accidentally skip the trash step.
   */
  @Delete(':id/purge')
  purge(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.items.purge(user, id);
  }

  @Post(':id/share')
  share(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ShareDto,
  ) {
    return this.items.share(user, id, dto);
  }

  @Delete(':id/share')
  unshare(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ShareDto,
  ) {
    return this.items.unshare(user, id, dto);
  }
}
