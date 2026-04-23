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
import { FeaturesModule } from './features/features.module.js';
import { MaintenanceModule } from './maintenance/maintenance.module.js';
import { AdminModule } from './admin/admin.module.js';
import { BasemapsModule } from './basemaps/basemaps.module.js';
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
    FeaturesModule,
    MaintenanceModule,
    AdminModule,
    BasemapsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Global auth guard; opt out per-route with @Public()
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
