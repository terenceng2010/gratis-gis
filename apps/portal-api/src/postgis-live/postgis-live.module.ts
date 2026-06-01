// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { ItemsModule } from '../items/items.module.js';
import { PostgisLiveController } from './postgis-live.controller.js';
import { PostgisLiveService_ } from './postgis-live.service.js';

@Module({
  imports: [PrismaModule, ItemsModule],
  controllers: [PostgisLiveController],
  providers: [PostgisLiveService_],
  exports: [PostgisLiveService_],
})
export class PostgisLiveModule {}
