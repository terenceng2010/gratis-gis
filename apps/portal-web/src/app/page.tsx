// SPDX-License-Identifier: AGPL-3.0-or-later
import { getServerSession } from 'next-auth';
import type { ItemType } from '@gratis-gis/shared-types';
import { authOptions } from '@/lib/auth';
import { loadWhatsNewEntries } from '@/lib/whats-new';
import { PublicLanding } from './public-landing';

export default async function HomePage(
  props: {
    searchParams?: Promise<{ preview?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const session = await getServerSession(authOptions);

  // #274: / always shows the public landing now, including for
  // authenticated visitors. This keeps the apex domain consistent
  // for every visitor (open-source marketing + the org's public
  // items) and gives signed-in folks an "Open my items" CTA that
  // takes them into their workspace. The previous tile-grid
  // dashboard ("Hey {name}, what would you like to do?") was a
  // lightweight redirect surface that doesn't earn its place when
  // the items list, top-bar nav, and per-item deep links are all
  // one click from anywhere else in the app.
  //
  // #255: ?preview=project remains as a dev override for forcing
  // the open-source project section on regardless of the
  // NEXT_PUBLIC_PROJECT_LANDING build flag (useful for layout
  // checks on prod before flipping the per-tenant flag).
  const previewProject = searchParams?.preview === 'project';
  const [data, whatsNew] = await Promise.all([
    loadLandingData(),
    // Cap at 5 entries so the landing card stays compact; the
    // markdown file can carry more for future-proofing.
    loadWhatsNewEntries(5),
  ]);
  return (
    <PublicLanding
      data={data}
      whatsNew={whatsNew}
      forceProjectSection={previewProject}
      isAuthenticated={!!session}
    />
  );
}

/**
 * Fetches landing config + public items for unauthenticated
 * visitors. Hits the portal-api's public endpoint, which doesn't
 * require a session. On failure (API down, no orgs seeded, etc.)
 * falls back to a minimal zero-items payload so the page still
 * renders with a sensible default.
 */
async function loadLandingData(): Promise<
  React.ComponentProps<typeof PublicLanding>['data']
> {
  const base =
    process.env.PORTAL_API_URL ??
    process.env.NEXT_PUBLIC_PORTAL_API_URL ??
    'http://localhost:4000';
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/public/landing`, {
      // Server-to-server call; always fresh data (no Next cache)
      // since the admin might have just flipped a toggle.
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`landing fetch ${res.status}`);
    return (await res.json()) as React.ComponentProps<
      typeof PublicLanding
    >['data'];
  } catch {
    return {
      org: {
        slug: 'gratisgis',
        name: 'GratisGIS',
        title: 'GratisGIS',
        subtitle: null,
        heroImageUrl: null,
        showPublicItems: false,
      },
      items: [],
    };
  }
}

// Narrow helper for ItemType usage by callers; referenced to keep
// TypeScript from pruning the import when the shape is passed
// straight through to <PublicLanding>.
export type _LandingItemType = ItemType;
