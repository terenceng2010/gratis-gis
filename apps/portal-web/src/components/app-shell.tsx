import Link from 'next/link';
import type { ReactNode } from 'react';
import { getServerSession } from 'next-auth';
import {
  Compass,
  LayoutGrid,
  Map as MapIcon,
  Users,
  Bell,
  Search,
} from 'lucide-react';
import { authOptions } from '@/lib/auth';

/**
 * Top-level chrome shared by every portal page: top bar with brand + search
 * + account, left nav with primary destinations, and a content area. One
 * consistent frame keeps the app feeling cohesive as we add surfaces.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const session = await getServerSession(authOptions);

  return (
    <div className="flex min-h-screen bg-surface-0 text-ink-0">
      <aside className="hidden w-60 shrink-0 border-r border-border bg-surface-1 px-3 py-4 md:block">
        <Link href="/" className="flex items-center gap-2 px-2 py-2">
          <Compass className="h-6 w-6 text-accent" />
          <span className="text-base font-semibold tracking-tight">GratisGIS</span>
        </Link>
        <nav className="mt-4 flex flex-col gap-0.5 text-sm">
          <NavLink href="/" icon={<LayoutGrid className="h-4 w-4" />}>Overview</NavLink>
          <NavLink href="/items" icon={<MapIcon className="h-4 w-4" />}>Items</NavLink>
          <NavLink href="/items?mine=true" icon={<LayoutGrid className="h-4 w-4" />}>My items</NavLink>
          <NavLink href="/groups" icon={<Users className="h-4 w-4" />}>Groups</NavLink>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-surface-0/80 px-4 backdrop-blur">
          <div className="flex flex-1 items-center gap-3">
            <label className="relative max-w-md flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                placeholder="Search items, groups, people…"
                className="h-9 w-full rounded-md border border-border bg-surface-1 pl-9 pr-3 text-sm text-ink-1 placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-surface-2"
              aria-label="Notifications"
            >
              <Bell className="h-4 w-4" />
            </button>
            {session ? (
              <Link
                href="/api/auth/signout"
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-xs font-medium text-accent-foreground">
                  {session.user?.name?.[0]?.toUpperCase() ?? '?'}
                </span>
                <span className="hidden md:inline">{session.user?.name}</span>
              </Link>
            ) : (
              <Link
                href="/api/auth/signin"
                className="inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90"
              >
                Sign in
              </Link>
            )}
          </div>
        </header>

        <main className="flex-1 animate-fade-in">{children}</main>
      </div>
    </div>
  );
}

function NavLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 rounded-md px-2 py-2 text-ink-1 transition-colors hover:bg-surface-2"
    >
      <span className="text-muted">{icon}</span>
      {children}
    </Link>
  );
}
