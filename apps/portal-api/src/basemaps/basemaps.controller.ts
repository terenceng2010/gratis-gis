import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { BasemapSourceKind, Prisma } from '@prisma/client';

import { BasemapsService } from './basemaps.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

const SOURCE_KIND_VALUES = ['xyz', 'vector-style', 'wms'] as const;

class CreateBasemapDto {
  @IsString() @MinLength(1) @MaxLength(120) label!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsString() @MinLength(1) @MaxLength(2048) url!: string;
  @IsEnum(SOURCE_KIND_VALUES) sourceKind!: BasemapSourceKind;
  @IsOptional() @IsString() @MaxLength(500) attribution?: string;
  @IsOptional() @IsString() @MaxLength(2048) thumbnailUrl?: string | null;
  // WMS-specific extras (layers, format, etc.); free-form JSON.
  @IsOptional() @IsObject() config?: Prisma.InputJsonValue;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

class UpdateBasemapDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) label?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(2048) url?: string;
  @IsOptional() @IsEnum(SOURCE_KIND_VALUES) sourceKind?: BasemapSourceKind;
  @IsOptional() @IsString() @MaxLength(500) attribution?: string;
  @IsOptional() @IsString() @MaxLength(2048) thumbnailUrl?: string | null;
  @IsOptional() @IsObject() config?: Prisma.InputJsonValue | null;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

@ApiTags('basemaps')
@ApiBearerAuth()
@Controller('basemaps')
export class BasemapsController {
  constructor(private readonly svc: BasemapsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.svc.list(user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.get(user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateBasemapDto) {
    return this.svc.create(user, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateBasemapDto,
  ) {
    return this.svc.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.svc.remove(user, id);
  }
}
