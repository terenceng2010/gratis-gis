// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from 'next/server';
import { loadDocBySlug } from '@/lib/help/content';

/**
 * One-doc endpoint for the help drawer.  Returns the rendered HTML
 * body + the resolved frontmatter title / summary so the drawer
 * doesn't have to fetch the index + body separately.  Cached at
 * the edge per slug.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const slug = req.nextUrl.searchParams.get('slug') ?? '';
  if (!slug) {
    return NextResponse.json({ error: 'missing slug' }, { status: 400 });
  }
  const segments = slug.split('/').filter(Boolean);
  const doc = await loadDocBySlug(segments);
  if (!doc) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json(
    {
      slug: doc.slug,
      title: doc.frontmatter.title,
      summary: doc.frontmatter.summary,
      html: doc.html,
    },
    {
      headers: {
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
      },
    },
  );
}
