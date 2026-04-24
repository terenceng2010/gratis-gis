import { Module } from '@nestjs/common';

import { V3FeaturesService } from './v3-features.service.js';
import { V3FeaturesController } from './v3-features.controller.js';
import { ItemsModule } from '../items/items.module.js';

/**
 * v3 feature CRUD surface. Depends on ItemsModule (for auth + ownership
 * checks at the controller) but not on V3TablesModule — tables are
 * provisioned upstream by ItemsService and this service just reads /
 * writes rows against the resulting tables.
 */
@Module({
  imports: [ItemsModule],
  providers: [V3FeaturesService],
  controllers: [V3FeaturesController],
  exports: [V3FeaturesService],
})
export class V3FeaturesModule {}
