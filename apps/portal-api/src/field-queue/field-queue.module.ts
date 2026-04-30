import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { FieldQueueService } from './field-queue.service.js';
import { FieldQueueController } from './field-queue.controller.js';

/**
 * Tier 4 of the field-offline resilience design (see
 * docs/field-offline-areas.md). The field client periodically POSTs a
 * queue manifest -- a metadata-only beacon describing what's stuck on
 * the device, with no record payloads -- so an admin can see "user X
 * has 47 records queued, oldest from 3 days ago" without the user
 * pulling out their phone.
 *
 * The admin controller lives in AdminModule (mirroring the
 * NotificationsAdminController pattern) so it picks up the
 * module-local AdminGuard without a cross-module guard dance. This
 * module exposes:
 *   - FieldQueueController POST /api/field/queue-manifest
 *     Authenticated user beacons their own device manifest. Server
 *     scopes the upsert to the caller's userId so a worker can't
 *     impersonate another device.
 *   - FieldQueueService for the admin controller (re-exported).
 */
@Module({
  imports: [PrismaModule],
  controllers: [FieldQueueController],
  providers: [FieldQueueService],
  exports: [FieldQueueService],
})
export class FieldQueueModule {}
