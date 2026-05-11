// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { ItemsModule } from '../items/items.module.js';
import { GeocodingController } from './geocoding.controller.js';
import { GeocodingService } from './geocoding.service.js';

/**
 * Runtime geocoding for geocoding_service items (#74). Sits next to
 * the items module; the runtime uses ItemsService for authorization
 * but otherwise reads observation log rows directly through the
 * shared Prisma client.
 */
@Module({
  imports: [ItemsModule],
  controllers: [GeocodingController],
  providers: [GeocodingService],
  exports: [GeocodingService],
})
export class GeocodingModule {}
