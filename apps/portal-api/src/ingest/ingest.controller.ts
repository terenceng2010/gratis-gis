import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SharingService } from '../items/sharing.service.js';
import { IngestService } from './ingest.service.js';

/**
 * Server-side ingest endpoint. Accepts a multipart upload of an
 * OGR-readable vector file and replaces the target feature_service
 * item's data with the converted GeoJSON.
 *
 * Only feature_service items are accepted as targets: web maps carry
 * camera state, files hold opaque bytes, and so on. The caller must
 * have edit rights on the item (owner or org admin, same rule as
 * PATCH /items/:id).
 */
@ApiTags('ingest')
@ApiBearerAuth()
@Controller('items')
export class IngestController {
  constructor(
    private readonly ingest: IngestService,
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly prisma: PrismaService,
  ) {}

  @Post(':id/ingest')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        // Multer enforces the same ceiling as IngestService. Defense in
        // depth is cheap and it gives users a clear 413 instead of
        // burning CPU on a 2 GB shapefile.
        fileSize: 100 * 1024 * 1024,
      },
    }),
  )
  async ingestFile(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded; field name must be "file".');
    }

    const item = await this.items.get(user, id);
    if (item.type !== 'feature_service') {
      throw new BadRequestException(
        'Server-side ingest only targets feature_service items.',
      );
    }
    const shares = await this.prisma.itemShare.findMany({ where: { itemId: id } });
    if (!this.sharing.canEdit(user, item, shares)) {
      throw new ForbiddenException('You do not have edit permission on this item.');
    }

    const { geojson, fields, driver } = await this.ingest.fileToGeoJson(
      file.buffer,
      file.originalname,
    );

    const data = {
      version: 1,
      fields: fields.map((f) => ({
        name: f.name,
        type: f.type,
        label: f.name,
        nullable: true,
      })),
      data: geojson,
      updatedAt: new Date().toISOString(),
    };

    await this.prisma.item.update({
      where: { id },
      data: { data: data as unknown as Prisma.InputJsonValue },
    });

    return {
      driver,
      features: geojson.features.length,
      fields: data.fields,
    };
  }
}
