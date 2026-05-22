// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  AgoImportService,
  type ImportReport,
} from './import.js';
import type { DryRunReport } from './dry-run.js';

/**
 * Snapshot of an AgoImportJob row shaped for the wizard's polling
 * endpoint. We omit the verbose requestPayload here -- the client
 * already has it from the preview step -- but include the final
 * `report` once status flips to a terminal state so the wizard can
 * render the per-item results table without a second round-trip.
 */
export interface AgoImportJobDto {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  total: number;
  done: number;
  currentItem: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  report: ImportReport | null;
}

/**
 * Input the controller hands us when a new run is queued. Mirrors
 * the synchronous /run dto but the `report` carries any per-item
 * willImport edits the operator made in the preview (include /
 * exclude).
 */
export interface StartJobInput {
  user: AuthUser;
  portalUrl: string;
  token: string;
  report: DryRunReport;
}

/**
 * Owns the AgoImportJob row lifecycle and the background runner
 * (#55). The runner is fire-and-forget in the same node process:
 * `start()` writes the queued row, returns its id, and schedules
 * `runJob()` for the next tick. Single-replica today; if we ever
 * scale portal-api horizontally we'd swap this for a real queue
 * with a `claim` step. The row's `status` + `started_at` would
 * make the migration straightforward.
 *
 * Cancellation: a row flipped to `cancelled` by the controller is
 * observed by the runner at the per-item boundary. Mid-item work
 * (e.g. a Feature Service feature copy in flight) still completes
 * before the runner notices, but no further items are imported.
 * This is the same shape the ingest ImportJob worker uses.
 */
@Injectable()
export class AgoImportJobsService {
  private readonly log = new Logger(AgoImportJobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly importer: AgoImportService,
  ) {}

  /**
   * Queue a new AGO migration job and kick off the background
   * runner. Returns immediately with the job id; the runner
   * writes progress + the final report back onto the same row.
   */
  async start(input: StartJobInput): Promise<{ id: string }> {
    const total = countWillImport(input.report);
    const row = await this.prisma.agoImportJob.create({
      data: {
        createdBy: input.user.id,
        orgId: input.user.orgId,
        status: 'queued',
        portalUrl: input.portalUrl,
        total,
        done: 0,
        requestPayload: input.report as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    // Fire-and-forget: schedule the runner for the next tick so
    // the HTTP response goes back to the caller right away. Any
    // failure inside runJob lands in the row's `errorMessage` and
    // flips status to `failed`; the .catch() here is defensive
    // and just logs (any real failure should already have been
    // captured by the runner's own try/catch).
    setImmediate(() => {
      this.runJob(row.id, input).catch((e) => {
        this.log.error(
          `AGO import job ${row.id} threw outside its handler: ${
            e instanceof Error ? e.message : e
          }`,
        );
      });
    });

    return { id: row.id };
  }

  /**
   * Fetch one job by id, scoped to the calling user's org. Throws
   * 404 when the row doesn't exist or belongs to a different org
   * (don't leak existence across org boundaries).
   */
  async get(user: AuthUser, id: string): Promise<AgoImportJobDto> {
    const row = await this.prisma.agoImportJob.findUnique({ where: { id } });
    if (!row || row.orgId !== user.orgId) {
      throw new NotFoundException(`AGO import job ${id} not found.`);
    }
    return toDto(row);
  }

  /**
   * Mark a job cancelled. The runner notices at the next per-item
   * boundary and stops. If the job is already in a terminal state
   * this is a no-op (returns the current row).
   */
  async cancel(user: AuthUser, id: string): Promise<AgoImportJobDto> {
    const row = await this.prisma.agoImportJob.findUnique({ where: { id } });
    if (!row || row.orgId !== user.orgId) {
      throw new NotFoundException(`AGO import job ${id} not found.`);
    }
    if (row.status === 'queued' || row.status === 'running') {
      const updated = await this.prisma.agoImportJob.update({
        where: { id },
        data: { status: 'cancelled', finishedAt: new Date() },
      });
      return toDto(updated);
    }
    return toDto(row);
  }

  /**
   * The background runner. Owns the full lifecycle: status to
   * `running`, write progress at every per-item boundary, write
   * the final report on completion, flip to `succeeded` /
   * `failed` / `cancelled`.
   *
   * Progress is written inline (one UPDATE per item) rather than
   * batched. AGO migrations are small enough that the extra
   * writes are noise; the smooth progress bar is worth more.
   */
  private async runJob(jobId: string, input: StartJobInput): Promise<void> {
    // Flip queued -> running. If the row was cancelled before
    // the runner started, respect that and exit.
    const queued = await this.prisma.agoImportJob.findUnique({
      where: { id: jobId },
    });
    if (!queued) return;
    if (queued.status !== 'queued') {
      this.log.warn(
        `AGO import job ${jobId} was ${queued.status} at runner start; skipping.`,
      );
      return;
    }
    await this.prisma.agoImportJob.update({
      where: { id: jobId },
      data: { status: 'running', startedAt: new Date() },
    });

    try {
      const report = await this.importer.run({
        user: input.user,
        portalUrl: input.portalUrl,
        token: input.token,
        report: input.report,
        // Per-item progress callback. The runner uses this to bump
        // done + currentItem on the row so the polling endpoint
        // can render a smooth progress bar. Cheap UPDATE; no need
        // to batch.
        onProgress: async (state) => {
          // Cancellation check piggybacks on the same UPDATE: if
          // the row is now cancelled we throw a sentinel error
          // that the outer catch will translate into the right
          // terminal state. Without this, the runner would keep
          // chewing through items even after the user clicked
          // Cancel in the UI.
          const fresh = await this.prisma.agoImportJob.findUnique({
            where: { id: jobId },
            select: { status: true },
          });
          if (fresh?.status === 'cancelled') {
            throw new JobCancelledError();
          }
          await this.prisma.agoImportJob.update({
            where: { id: jobId },
            data: {
              done: state.done,
              currentItem: state.currentItem || null,
            },
          });
        },
      });

      await this.prisma.agoImportJob.update({
        where: { id: jobId },
        data: {
          status: 'succeeded',
          finishedAt: new Date(),
          done: report.total,
          report: report as unknown as Prisma.InputJsonValue,
          currentItem: null,
        },
      });
    } catch (e) {
      if (e instanceof JobCancelledError) {
        // Cancellation was already persisted by `cancel()`. Just
        // make sure finishedAt + currentItem are set so the UI
        // doesn't show "in progress" forever.
        await this.prisma.agoImportJob.update({
          where: { id: jobId },
          data: { finishedAt: new Date(), currentItem: null },
        });
        return;
      }
      this.log.error(
        `AGO import job ${jobId} failed: ${
          e instanceof Error ? e.message : e
        }`,
      );
      await this.prisma.agoImportJob.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          errorMessage:
            e instanceof Error ? e.message : 'Unknown runner error',
        },
      });
    }
  }
}

class JobCancelledError extends Error {
  constructor() {
    super('Job cancelled by caller');
  }
}

function countWillImport(report: DryRunReport): number {
  let n = 0;
  for (const item of report.items) {
    if (item.willImport) n += 1;
  }
  return n;
}

function toDto(row: {
  id: string;
  status: string;
  total: number;
  done: number;
  currentItem: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  report: Prisma.JsonValue;
}): AgoImportJobDto {
  return {
    id: row.id,
    status: row.status as AgoImportJobDto['status'],
    total: row.total,
    done: row.done,
    currentItem: row.currentItem,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    report: (row.report as unknown as ImportReport | null) ?? null,
  };
}
