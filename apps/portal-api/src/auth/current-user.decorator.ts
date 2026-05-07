// SPDX-License-Identifier: AGPL-3.0-or-later
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthUser } from './auth-sync.service.js';

/** Inject the authenticated user into a controller handler. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    return ctx.switchToHttp().getRequest().user as AuthUser;
  },
);
