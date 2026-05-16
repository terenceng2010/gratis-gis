// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from 'next/server';
import { buildSearchIndex } from '@/lib/help/content';

/**
 * Slim search index for the global help drawer.  Fetched once per
 * session, cached.  Returns title + summary + slug + controls +
 * a lowercased haystack -- enough for fuzzy substring scoring
 * client-side without shipping full doc bodies.
 */
export const dynamic = 'force-static';

export async function GET(): Promise<NextResponse> {
  const index = await buildSearchIndex();
  return NextResponse.json(index, {
    headers: {
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
    },
  });
}
