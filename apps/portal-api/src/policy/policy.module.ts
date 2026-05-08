// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { LensPolicyService } from './lens-policy.service.js';
import { PolicyService } from './policy.service.js';

/**
 * Cedar-policy authorization module. Standalone so callers can
 * depend on it without dragging in items / sharing / prisma.
 *
 * Exports:
 *   - PolicyService     -- low-level Cedar evaluator (Phase A); the
 *                          callsite for SharingService's Item-level
 *                          gate (Phase B).
 *   - LensPolicyService -- row-level filter that runs lens-attached
 *                          Cedar policies against per-feature inputs
 *                          (Phase C). Spatial predicates are
 *                          pre-resolved in PostGIS upstream and fed
 *                          in as a Set<string>.
 */
@Module({
  providers: [PolicyService, LensPolicyService],
  exports: [PolicyService, LensPolicyService],
})
export class PolicyModule {}
