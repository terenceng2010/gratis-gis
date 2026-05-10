// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Client as PgClient } from 'pg';

/**
 * Process-wide leader election via PostgreSQL session-level
 * advisory locks (#115 #2 horizontal-scale).
 *
 * Why we need it: with N>1 portal-api replicas behind a load
 * balancer, every @Cron handler in the codebase fires on every
 * replica. Most of them aren't idempotent at N-fan-out:
 *   - BackupCronService would write N concurrent pg_dumps
 *     against the same archive directory and step on each
 *     other.
 *   - HousekeepingCronService would email the same admin N
 *     times every interval.
 *   - notifications.worker would drain the queue N times,
 *     racing the same submitted-rows window.
 *   - ingest-staging cleanup would race-delete each other's
 *     in-flight tmp files.
 *
 * The cheap, no-extra-infra answer is a Postgres advisory lock.
 * On boot we open a dedicated long-lived pg connection and try
 * pg_try_advisory_lock(). The first replica to acquire wins;
 * subsequent replicas' attempts return false and they noop on
 * cron handlers (`shouldRun()` returns false). The lock is
 * tied to the connection's lifetime, so when the leader dies
 * the connection drops, the lock auto-releases, and the next
 * replica to call onModuleInit (or to retry) becomes leader.
 *
 * Static-leader-on-boot is enough for v1 because docker-compose
 * `restart: unless-stopped` brings a dead leader right back.
 * If we ever want sub-second failover, a second timer in this
 * service can poll-acquire on followers; not needed yet.
 *
 * The lock key is a pair of int4 values; we picked a
 * GratisGIS-specific magic number for the namespace (the int4
 * representation of the ascii bytes "GGIS" interpreted as a
 * little-endian uint32) and 1 for the cron-leader scope.
 */
const LEADER_NAMESPACE = 0x47474953; // 'GGIS'
const LEADER_SCOPE_CRONS = 1;

@Injectable()
export class LeaderElectionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LeaderElectionService.name);
  private client: PgClient | null = null;
  private isLeader = false;

  async onModuleInit(): Promise<void> {
    // Some non-prod / test boots set ENABLE_CRONS=false explicitly
    // because they don't want cron side-effects regardless of
    // leadership. Honor that without ever attempting the lock so
    // a missing DATABASE_URL doesn't crash boot in those cases.
    if (process.env.ENABLE_CRONS === 'false') {
      this.log.log('ENABLE_CRONS=false — skipping leader election; this replica will never run crons.');
      return;
    }

    const url = process.env.DATABASE_URL;
    if (!url) {
      this.log.warn(
        'DATABASE_URL not set; cannot acquire leader lock. Crons will run on every replica until this is fixed.',
      );
      this.isLeader = true;
      return;
    }

    this.client = new PgClient({ connectionString: url });
    try {
      await this.client.connect();
      const result = await this.client.query<{ got: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS got',
        [LEADER_NAMESPACE, LEADER_SCOPE_CRONS],
      );
      this.isLeader = result.rows[0]?.got === true;
      if (this.isLeader) {
        this.log.log(
          `Leader lock acquired (namespace=${LEADER_NAMESPACE}, scope=${LEADER_SCOPE_CRONS}); this replica will run cron jobs.`,
        );
      } else {
        this.log.log(
          'Another replica holds the leader lock; this replica will skip cron jobs.',
        );
      }
    } catch (err) {
      this.log.warn(
        `Leader-election lock query failed: ${
          err instanceof Error ? err.message : err
        }. Defaulting to leader=false to avoid double-firing crons.`,
      );
      this.isLeader = false;
      // Tear down the half-broken client so the connection isn't
      // left dangling.
      try {
        await this.client.end();
      } catch {
        /* best effort */
      }
      this.client = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      // Releasing the lock explicitly is technically optional --
      // closing the connection drops it -- but explicit unlock is
      // friendlier to a slow-to-disconnect Postgres.
      try {
        await this.client.query('SELECT pg_advisory_unlock($1, $2)', [
          LEADER_NAMESPACE,
          LEADER_SCOPE_CRONS,
        ]);
      } catch {
        /* shutting down anyway */
      }
      try {
        await this.client.end();
      } catch {
        /* shutting down anyway */
      }
      this.client = null;
    }
    this.isLeader = false;
  }

  /**
   * Returns true if this process holds the cron-leader lock.
   * Cron handlers (and any other "exactly-once-across-replicas"
   * recurring work) should early-return when this is false:
   *
   *   @Cron('0 2 * * *')
   *   async dailyBackup() {
   *     if (!this.leader.shouldRun()) return;
   *     // ...
   *   }
   */
  shouldRun(): boolean {
    return this.isLeader;
  }
}
