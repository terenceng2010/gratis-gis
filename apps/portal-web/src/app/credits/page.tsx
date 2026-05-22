// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import type { Metadata } from 'next';
import { getServerSession } from 'next-auth';
import { ArrowLeft, Compass, ExternalLink, Heart, LogIn } from 'lucide-react';
import { authOptions } from '@/lib/auth';

/**
 * /credits - the project's "what we are built on" page. Lists
 * the load-bearing open-source projects GratisGIS uses, with
 * a specific thanks section for the small-team / single-maintainer
 * libraries where visibility is part of how those projects stay
 * sustainable.
 *
 * Public-shell layout matches /why so a visitor can land on
 * either page directly from a search engine or a shared link.
 */
export const metadata: Metadata = {
  title: 'Built on - GratisGIS',
  description:
    'The open-source projects GratisGIS stands on. Stack overview plus a specific thanks to the maintainers whose work makes everything possible.',
};

interface StackRow {
  layer: string;
  /** Display name; can include multiple links (rendered comma-separated). */
  projects: Array<{ label: string; href: string }>;
}

interface AcknowledgmentRow {
  name: string;
  handle: string;
  /** Where to point people who want to find them. */
  href: string;
  /** What they're being thanked for in this project. */
  why: string;
}

const STACK: StackRow[] = [
  {
    layer: 'Language',
    projects: [{ label: 'TypeScript', href: 'https://www.typescriptlang.org/' }],
  },
  {
    layer: 'Backend API',
    projects: [
      { label: 'Node.js', href: 'https://nodejs.org/' },
      { label: 'NestJS', href: 'https://nestjs.com/' },
    ],
  },
  {
    layer: 'Database',
    projects: [
      { label: 'PostgreSQL', href: 'https://www.postgresql.org/' },
      { label: 'PostGIS', href: 'https://postgis.net/' },
    ],
  },
  {
    layer: 'ORM / migrations',
    projects: [{ label: 'Prisma', href: 'https://www.prisma.io/' }],
  },
  {
    layer: 'Auth / identity',
    projects: [{ label: 'Keycloak', href: 'https://www.keycloak.org/' }],
  },
  {
    layer: 'Authorization',
    projects: [
      { label: 'Cedar', href: 'https://www.cedarpolicy.com/' },
    ],
  },
  {
    layer: 'Object storage',
    projects: [{ label: 'MinIO', href: 'https://min.io/' }],
  },
  {
    layer: 'HTTP edge',
    projects: [{ label: 'Caddy', href: 'https://caddyserver.com/' }],
  },
  {
    layer: 'Tile serving',
    projects: [
      {
        label: 'pg_tileserv',
        href: 'https://github.com/CrunchyData/pg_tileserv',
      },
    ],
  },
  {
    layer: 'Web frontend',
    projects: [
      { label: 'Next.js', href: 'https://nextjs.org/' },
      { label: 'React', href: 'https://react.dev/' },
    ],
  },
  {
    layer: 'Map rendering',
    projects: [{ label: 'MapLibre GL', href: 'https://maplibre.org/' }],
  },
  {
    layer: 'Drawing tools',
    projects: [
      { label: 'Terra Draw', href: 'https://terradraw.io/' },
    ],
  },
  {
    layer: 'Tile bundles',
    projects: [
      { label: 'PMTiles', href: 'https://github.com/protomaps/PMTiles' },
    ],
  },
  {
    layer: 'Spatial indexing',
    projects: [{ label: 'h3-js', href: 'https://github.com/uber/h3-js' }],
  },
  {
    layer: 'KML / GPX import',
    projects: [
      { label: '@tmcw/togeojson', href: 'https://github.com/tmcw/togeojson' },
    ],
  },
  {
    layer: 'Shapefile import',
    projects: [
      { label: 'shpjs', href: 'https://github.com/calvinmetcalf/shapefile-js' },
    ],
  },
  {
    layer: 'Raster / vector I/O',
    projects: [
      { label: 'GDAL', href: 'https://gdal.org/' },
      {
        label: 'gdal-async',
        href: 'https://github.com/mmomtchev/node-gdal-async',
      },
    ],
  },
  {
    layer: 'Component kit',
    projects: [{ label: 'shadcn/ui', href: 'https://ui.shadcn.com/' }],
  },
  {
    layer: 'Motion',
    projects: [
      { label: 'framer-motion', href: 'https://www.framer.com/motion/' },
    ],
  },
  {
    layer: 'Charts',
    projects: [{ label: 'Recharts', href: 'https://recharts.org/' }],
  },
  {
    layer: 'Icons',
    projects: [{ label: 'lucide-react', href: 'https://lucide.dev/' }],
  },
  {
    layer: 'Markdown',
    projects: [{ label: 'marked', href: 'https://marked.js.org/' }],
  },
  {
    layer: 'Styling',
    projects: [{ label: 'Tailwind CSS', href: 'https://tailwindcss.com/' }],
  },
  {
    layer: 'Monorepo',
    projects: [
      { label: 'pnpm', href: 'https://pnpm.io/' },
      { label: 'Turborepo', href: 'https://turborepo.com/' },
    ],
  },
];

const ACKNOWLEDGMENTS: AcknowledgmentRow[] = [
  {
    name: 'Paul Ramsey',
    handle: '@pramsey',
    href: 'https://github.com/pramsey',
    why:
      'PostGIS + pg_tileserv. The spatial database substrate the whole project sits on, plus our tile-server fallback for admin basemaps.',
  },
  {
    name: 'James Milner',
    handle: '@JamesLMilner',
    href: 'https://github.com/JamesLMilner',
    why:
      'Terra Draw and the MapLibre adapter. Every drawing surface in GratisGIS (map editor, geo-boundary editor, field PWA, editor template) runs on Terra Draw.',
  },
  {
    name: 'Brandon Liu',
    handle: '@bdon',
    href: 'https://github.com/bdon',
    why:
      'PMTiles and the Protomaps stack. The format that lets us host tiled raster pyramids as static MinIO objects with no tile-server in the request path.',
  },
  {
    name: 'Tom MacWright',
    handle: '@tmcw',
    href: 'https://github.com/tmcw',
    why:
      'togeojson and much of the geospatial JS ecosystem we lean on. KML / GPX import in the file-upload flow runs through his library.',
  },
  {
    name: 'Calvin Metcalf',
    handle: '@calvinmetcalf',
    href: 'https://github.com/calvinmetcalf',
    why: 'shpjs. Shapefile uploads parse through it.',
  },
  {
    name: 'Brian Carlson',
    handle: '@brianc',
    href: 'https://github.com/brianc',
    why:
      'node-postgres + pg-copy-streams. Every Postgres call from the API goes through his work.',
  },
  {
    name: 'Momtchil Momtchev',
    handle: '@mmomtchev',
    href: 'https://github.com/mmomtchev',
    why:
      'node-gdal-async. The Node bindings that let our ingest + raster-pyramid worker use GDAL without shelling out.',
  },
];

export default async function CreditsPage() {
  const session = await getServerSession(authOptions);
  const isAuthenticated = !!session;

  return (
    <div className="flex min-h-screen flex-col bg-surface-0">
      {!isAuthenticated ? <TopBar /> : null}

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 sm:py-16">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-ink-0"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to home
        </Link>

        <header className="mt-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            Built on
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink-0 sm:text-4xl">
            The open-source projects we stand on.
          </h1>
          <p className="mt-3 text-base text-muted">
            GratisGIS leans on a stack of open-source projects, many
            of them maintained by small teams or single people doing
            remarkable work. If you find GratisGIS useful, consider
            sending some of that goodwill upstream too.
          </p>
        </header>

        <section className="mt-10">
          <h2 className="text-lg font-semibold tracking-tight text-ink-0">
            Stack at a glance
          </h2>
          <div className="mt-4 overflow-hidden rounded-md border border-border bg-surface-1">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Layer</th>
                  <th className="px-3 py-2 font-medium">Project(s)</th>
                </tr>
              </thead>
              <tbody>
                {STACK.map((row) => (
                  <tr
                    key={row.layer}
                    className="border-t border-border align-top"
                  >
                    <td className="px-3 py-2 text-ink-1">{row.layer}</td>
                    <td className="px-3 py-2">
                      {row.projects.map((p, i) => (
                        <span key={p.label}>
                          {i > 0 ? ', ' : ''}
                          <a
                            href={p.href}
                            target="_blank"
                            rel="noreferrer"
                            className="text-accent hover:underline"
                          >
                            {p.label}
                          </a>
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-12">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-ink-0">
            <Heart className="h-4 w-4 text-accent" />A specific thank-you to
          </h2>
          <p className="mt-2 text-sm text-muted">
            Some of the most load-bearing pieces of this project are
            maintained by individuals or small teams whose names
            rarely appear next to the products they enable. Visibility
            is part of how their work stays sustainable.
          </p>
          <ul className="mt-5 space-y-4">
            {ACKNOWLEDGMENTS.map((row) => (
              <li
                key={row.handle}
                className="rounded-md border border-border bg-surface-1 p-4"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <a
                    href={row.href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-semibold text-ink-0 hover:underline"
                  >
                    {row.name}
                  </a>
                  <a
                    href={row.href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-xs text-muted hover:text-ink-0"
                  >
                    {row.handle}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <p className="mt-1.5 text-sm text-ink-1">{row.why}</p>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-sm text-muted">
            The Cedar team at AWS, the PostGIS contributors, the
            MapLibre contributors, the NestJS + Prisma + Next.js +
            React + Tailwind core teams, the OGC working groups whose
            standards we build against - same gratitude, just too
            many names to list here.
          </p>
        </section>
      </main>

      <footer className="border-t border-border bg-surface-1 py-6 text-center text-xs text-muted">
        Powered by GratisGIS &middot;{' '}
        <Link href="/" className="underline hover:text-ink-0">
          Home
        </Link>{' '}
        &middot;{' '}
        <Link href="/why" className="underline hover:text-ink-0">
          Why GratisGIS
        </Link>
      </footer>
    </div>
  );
}

/**
 * Same minimal top bar /why uses, kept in sync deliberately so the
 * two public pages have matching chrome.
 */
function TopBar() {
  return (
    <header className="flex items-center justify-between border-b border-border bg-surface-1 px-6 pt-[env(safe-area-inset-top)] [height:calc(3.5rem+env(safe-area-inset-top))]">
      <Link href="/" className="flex items-center gap-2">
        <Compass className="h-6 w-6 text-accent" />
        <span className="text-base font-semibold tracking-tight">
          GratisGIS
        </span>
      </Link>
      <Link
        href="/signin"
        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90"
      >
        <LogIn className="h-4 w-4" />
        Sign in
      </Link>
    </header>
  );
}
