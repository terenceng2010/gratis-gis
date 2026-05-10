// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';

import { HealthController } from './health.controller.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { GroupsModule } from './groups/groups.module.js';
import { ItemsModule } from './items/items.module.js';
import { StorageModule } from './storage/storage.module.js';
import { IngestModule } from './ingest/ingest.module.js';
import { ImportJobsModule } from './import-jobs/import-jobs.module.js';
import { FeaturesModule } from './features/features.module.js';
import { MaintenanceModule } from './maintenance/maintenance.module.js';
import { AdminModule } from './admin/admin.module.js';
import { DataLayerFeaturesModule } from './data-layer/features.module.js';
import { PublicModule } from './public/public.module.js';
import { BackupModule } from './backup/backup.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { FormsModule } from './forms/forms.module.js';
import { FieldQueueModule } from './field-queue/field-queue.module.js';
import { EngineModule } from './engine/engine.module.js';
import { PolicyModule } from './policy/policy.module.js';
import { JwtAuthGuard } from './auth/jwt-auth.guard.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    UsersModule,
    GroupsModule,
    ItemsModule,
    StorageModule,
    IngestModule,
    ImportJobsModule,
    FeaturesModule,
    MaintenanceModule,
    AdminModule,
    DataLayerFeaturesModule,
    PublicModule,
    BackupModule,
    NotificationsModule,
    FormsModule,
    FieldQueueModule,
    EngineModule,
    PolicyModule,
  ],
  controllers: [HealthController],
  providers: [
    // Global auth guard; opt out per-route with @Public()
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
