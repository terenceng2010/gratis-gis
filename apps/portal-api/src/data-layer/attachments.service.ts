// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';

/**
 * Per-feature attachments for v3 feature-service items. Metadata lives
 * in the `feature_attachment` table; bytes live in MinIO at
 * `storageKey`. Writes go through presigned PUT to MinIO first, then
 * the client calls `register()` here to record the metadata. This
 * mirrors the thumbnail flow and keeps portal-api off the hot upload
 * path (no buffering 25 MB files through Node).
 */
export interface RegisterAttachmentInput {
  fileName: string;
  mime: string;
  sizeBytes: number;
  /** MinIO object key returned from the presign step. */
  storageKey: string;
  /** Public URL returned from the presign step. */
  storageUrl: string;
}

@Injectable()
export class DataLayerAttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  list(itemId: string, layerId: string, featureId: string) {
    return this.prisma.featureAttachment.findMany({
      where: { itemId, layerId, featureId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        fileName: true,
        mime: true,
        sizeBytes: true,
        storageUrl: true,
        createdAt: true,
        createdBy: true,
      },
    });
  }

  async register(
    itemId: string,
    layerId: string,
    featureId: string,
    input: RegisterAttachmentInput,
    userId: string,
  ) {
    return this.prisma.featureAttachment.create({
      data: {
        itemId,
        layerId,
        featureId,
        fileName: input.fileName,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        storageKey: input.storageKey,
        storageUrl: input.storageUrl,
        createdBy: userId,
      },
      select: {
        id: true,
        fileName: true,
        mime: true,
        sizeBytes: true,
        storageUrl: true,
        createdAt: true,
        createdBy: true,
      },
    });
  }

  /**
   * Delete an attachment row AND its MinIO object. Object delete is
   * best-effort; a stuck metadata row is worse than a leaked 25 MB
   * object, so we don't rollback the DB on storage failure (the
   * storage service logs and swallows).
   */
  async remove(
    itemId: string,
    layerId: string,
    featureId: string,
    attachmentId: string,
  ): Promise<void> {
    const row = await this.prisma.featureAttachment.findFirst({
      where: { id: attachmentId, itemId, layerId, featureId },
      select: { id: true, storageKey: true },
    });
    if (!row) throw new NotFoundException('Attachment not found');
    await this.prisma.featureAttachment.delete({ where: { id: row.id } });
    await this.storage.deleteObject(row.storageKey);
  }
}
