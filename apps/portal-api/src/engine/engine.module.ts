// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { EngineService } from './engine.service.js';

@Module({
  providers: [EngineService],
  exports: [EngineService],
})
export class EngineModule {}
