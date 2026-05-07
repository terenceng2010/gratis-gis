// SPDX-License-Identifier: AGPL-3.0-or-later
import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/public.decorator.js';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check() {
    return { status: 'ok', ts: new Date().toISOString() };
  }
}
