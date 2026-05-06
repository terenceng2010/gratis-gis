import { Module } from '@nestjs/common';
import { PublicController } from './public.controller.js';
import { PublicOgcController } from './public-ogc.controller.js';
import { PublicCswController } from './public-csw.controller.js';
import { PublicProxyController } from './public-proxy.controller.js';
import { V3FeaturesModule } from '../features-v3/v3-features.module.js';
import { ItemsModule } from '../items/items.module.js';

/**
 * Unauthenticated endpoints. Kept in its own module so the audit
 * trail of "what the internet can see" is easy to grep: a small set
 * of controllers, no business services beyond what the OGC surface
 * borrows from V3FeaturesModule and what the public proxy borrows
 * from ItemsModule (CredentialService for upstream auth injection).
 */
@Module({
  imports: [V3FeaturesModule, ItemsModule],
  controllers: [
    PublicController,
    PublicOgcController,
    PublicCswController,
    PublicProxyController,
  ],
})
export class PublicModule {}
