// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { PolicyService } from './policy.service.js';

/**
 * Cedar-policy authorization module. Standalone so the engine
 * can depend on it without dragging in items / sharing / prisma
 * (the hand-rolled SharingService is unaffected for v1; Phase A.2
 * migrates those callsites).
 */
@Module({
  providers: [PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
