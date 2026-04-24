import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from './admin.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { HousekeepingService } from './housekeeping.service.js';

/**
 * Admin-only housekeeping dashboard. Pure read endpoints — the
 * admin takes action on individual items / users through the
 * existing detail pages (reassign, delete, disable). Keeping the
 * actions scoped there means the audit log and permissions model
 * work the same way whether the admin reached the item from this
 * page or anywhere else.
 */
@ApiTags('admin', 'housekeeping')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/housekeeping')
export class HousekeepingController {
  constructor(private readonly housekeeping: HousekeepingService) {}

  @Get('summary')
  summary(@CurrentUser() user: AuthUser) {
    return this.housekeeping.summary(user.orgId);
  }

  @Get('stale-items')
  staleItems(@CurrentUser() user: AuthUser) {
    return this.housekeeping.staleItems(user.orgId);
  }

  @Get('stale-users')
  staleUsers(@CurrentUser() user: AuthUser) {
    return this.housekeeping.staleUsers(user.orgId);
  }

  @Get('large-items')
  largeItems(@CurrentUser() user: AuthUser) {
    return this.housekeeping.largeItems(user.orgId);
  }
}
