import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { V3FeaturesModule } from '../features-v3/v3-features.module.js';
import { FormsController } from './forms.controller.js';
import { FormsService } from './forms.service.js';

/**
 * Form submission storage + access (#131). The form item itself
 * (the schema) lives in the Items module; this module only owns
 * captured responses.
 *
 * V3FeaturesModule is imported (#281e) so submissions can also be
 * mirrored into the paired data_layer that ItemsService.create
 * auto-provisions for every form item (#283 / #281c).
 */
@Module({
  imports: [PrismaModule, NotificationsModule, V3FeaturesModule],
  controllers: [FormsController],
  providers: [FormsService],
  exports: [FormsService],
})
export class FormsModule {}
