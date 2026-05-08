// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { PublicController } from './public.controller.js';
import { PublicOgcController } from './public-ogc.controller.js';
import { PublicCswController } from './public-csw.controller.js';
import { PublicProxyController } from './public-proxy.controller.js';
import { DataLayerFeaturesModule } from '../data-layer/features.module.js';
import { ItemsModule } from '../items/items.module.js';

/**
 * Unauthenticated endpoints. Kept in its own module so the audit
 * trail of "what the internet can see" is easy to grep: a small set
 * of controllers, no business services beyond what the OGC surface
 * borrows from DataLayerFeaturesModule and what the public proxy borrows
 * from ItemsModule (CredentialService for upstream auth injection).
 */
@Module({
  imports: [DataLayerFeaturesModule, ItemsModule],
  controllers: [
    PublicController,
    PublicOgcController,
    PublicCswController,
    PublicProxyController,
  ],
})
export class PublicModule {}
