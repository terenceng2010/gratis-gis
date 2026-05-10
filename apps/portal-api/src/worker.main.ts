// SPDX-License-Identifier: AGPL-3.0-or-later
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { Module } from '@nestjs/common';

import { ImportJobsWorkerModule } from './import-jobs/import-jobs-worker.module.js';
import { LeaderElectionModule } from './cron/leader-election.module.js';

/**
 * portal-worker entry point (#115 P8).
 *
 * Runs the same image as portal-api but bootstraps a standalone
 * Nest application context (no HTTP listener) that loads only the
 * worker-side modules. The ImportJobsWorker's polling loop keeps
 * the process alive; SIGTERM / SIGINT closes it cleanly.
 *
 * Why a separate process instead of a thread:
 *   - The Node event loop is process-scoped. CPU-heavy work in
 *     the worker (gdal-async feature pumps, EWKT serialization,
 *     COPY stream encoding) blocks every other piece of JS in
 *     the same process. With the worker in its own container,
 *     the api stays responsive to user requests no matter what
 *     the worker is doing.
 *   - Horizontal scale: scaling the worker doesn't drag the api
 *     with it. A burst of imports just spawns more
 *     portal-worker containers; the api stays at its baseline.
 *   - Memory isolation: a runaway import that OOMs the process
 *     only kills the worker, not the api.
 *
 * Co-deployed with portal-api: same docker image, different
 * CMD. The container shares the staging volume with the api so
 * files uploaded via POST /ingest/stage are readable here.
 */
@Module({
  imports: [LeaderElectionModule, ImportJobsWorkerModule],
})
class WorkerAppModule {}

async function bootstrap() {
  const log = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    bufferLogs: false,
  });
  // Graceful shutdown: tear down Nest providers (closes Prisma,
  // releases the worker's polling timer) before the container
  // process exits. Without this, an in-flight import job's COPY
  // transaction would be left dangling when docker stops the
  // container.
  app.enableShutdownHooks();
  log.log('portal-worker ready');

  // The ImportJobsWorker's polling loop keeps the event loop
  // busy; nothing else here. We do not call app.close() because
  // the process should run forever (until killed).
}

void bootstrap();
