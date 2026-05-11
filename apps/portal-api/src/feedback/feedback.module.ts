// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module.js';
import { FeedbackController } from './feedback.controller.js';
import { FeedbackService } from './feedback.service.js';

/**
 * Anonymous feedback intake (#146). Reuses the existing
 * EmailTransport from NotificationsModule so we don't have a second
 * SMTP wrapper kicking around. Public surface area is a single
 * unauthenticated POST /feedback.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [FeedbackController],
  providers: [FeedbackService],
})
export class FeedbackModule {}
