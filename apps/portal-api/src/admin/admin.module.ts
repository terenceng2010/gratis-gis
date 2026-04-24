import { Module } from '@nestjs/common';

import { AdminUsersController } from './admin-users.controller.js';
import { AdminBrandingController } from './admin-branding.controller.js';
import { AdminGuard } from './admin.guard.js';
import { KeycloakAdminService } from './keycloak-admin.service.js';

/**
 * Wires the Keycloak-admin integration. All controllers under /admin/*
 * are gated by AdminGuard (instance-scoped via @UseGuards) and call
 * KeycloakAdminService for the actual IdP-side mutations.
 *
 * The service is safe to instantiate even when the admin credentials
 * aren't configured — it throws a descriptive 503 on first call
 * instead of crashing app bootstrap. That keeps the base portal
 * running for operators who haven't enabled user management yet.
 */
@Module({
  controllers: [AdminUsersController, AdminBrandingController],
  providers: [KeycloakAdminService, AdminGuard],
  exports: [KeycloakAdminService],
})
export class AdminModule {}
