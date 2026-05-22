// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { MapIconsController } from './map-icons.controller.js';

/**
 * Wires the SVG-upload + list endpoints for the map point-symbol
 * picker (#73). Depends on PrismaModule (per-org index) and
 * StorageModule (MinIO put / serve). The picker's bundled lucide
 * icon set lives entirely client-side and doesn't need a
 * backend; only the user-uploaded SVG flow touches the api.
 */
@Module({
  imports: [PrismaModule, StorageModule],
  controllers: [MapIconsController],
})
export class MapIconsModule {}
