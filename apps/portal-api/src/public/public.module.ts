import { Module } from '@nestjs/common';
import { PublicController } from './public.controller.js';

/**
 * Unauthenticated endpoints. Kept in its own module so the audit
 * trail of 'what the internet can see' is easy to grep — one
 * controller, zero services, one export point.
 */
@Module({
  controllers: [PublicController],
})
export class PublicModule {}
