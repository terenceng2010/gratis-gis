// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { EngineService } from './engine.service.js';
import { DataLayerEngine } from './data-layer.js';

@Module({
  providers: [EngineService, DataLayerEngine],
  exports: [EngineService, DataLayerEngine],
})
export class EngineModule {}
