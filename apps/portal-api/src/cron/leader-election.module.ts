// SPDX-License-Identifier: AGPL-3.0-or-later
import { Global, Module } from '@nestjs/common';

import { LeaderElectionService } from './leader-election.service.js';

/**
 * Global module so any cron-bearing service can DI the
 * LeaderElectionService without each feature module repeating
 * the import. The lock connection is process-singleton, which
 * is the correct shape for this responsibility.
 */
@Global()
@Module({
  providers: [LeaderElectionService],
  exports: [LeaderElectionService],
})
export class LeaderElectionModule {}
