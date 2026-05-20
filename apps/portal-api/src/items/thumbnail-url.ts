// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Prisma } from '@prisma/client';

/**
 * Synthesize a `thumbnailUrl` for an item row that ships a
 * `thumbnailDesign` JSON blob but no static uploaded
 * `thumbnailUrl`. Returns the row untouched when the static URL is
 * already set OR no design exists.
 *
 * Why this exists as a shared helper: thumbnailDesign is the
 * portal's designer-baked thumbnail (server-rendered SVG/PNG on
 * demand at `/api/portal/items/:id/thumbnail.svg`). The renderer
 * reads the row's current title + type live, so this URL just
 * needs to point at the right item with a cache-buster keyed on
 * `updatedAt`; renames bump `updatedAt`, browsers refetch.
 *
 * Used by items.service.ts (the auth'd read path) AND
 * public.controller.ts (the anon catalog + landing tile paths) so
 * the same item displays the same thumbnail regardless of which
 * endpoint the caller used to fetch it.
 */
export function synthesizeThumbnailUrl<
  T extends {
    id: string;
    updatedAt: Date;
    thumbnailUrl: string | null;
    thumbnailDesign?: Prisma.JsonValue | null;
  },
>(row: T): T {
  if (row.thumbnailUrl) return row;
  if (!row.thumbnailDesign) return row;
  const v = row.updatedAt.getTime();
  return {
    ...row,
    thumbnailUrl: `/api/portal/items/${row.id}/thumbnail.svg?v=${v}`,
  };
}
