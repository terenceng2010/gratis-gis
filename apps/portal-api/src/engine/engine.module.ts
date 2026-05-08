// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { EngineService } from './engine.service.js';
import { DataLayerEngine } from './data-layer.js';
import { PolicyModule } from '../policy/policy.module.js';

@Module({
  imports: [PolicyModule],
  providers: [EngineService, DataLayerEngine],
  exports: [EngineService, DataLayerEngine],
})
export class EngineModule {}
