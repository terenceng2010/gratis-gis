// SPDX-License-Identifier: AGPL-3.0-or-later
import { SetMetadata } from '@nestjs/common';

/** Mark a route handler as not requiring auth. */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
