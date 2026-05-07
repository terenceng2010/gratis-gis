// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { AdminModule } from '../admin/admin.module.js';

/**
 * AdminModule is imported so `/users/me` can push Keycloak-side updates
 * (name / email) through the KeycloakAdminService when a user edits
 * their own profile. The module already exports the service, and gating
 * on AdminGuard is scoped per-controller rather than module-wide, so
 * importing here doesn't accidentally require admin role for regular
 * self-service endpoints.
 */
@Module({
  imports: [AdminModule],
  controllers: [UsersController],
})
export class UsersModule {}
