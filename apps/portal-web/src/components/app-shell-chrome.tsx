'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import {
  Archive,
  Bell,
  ClipboardList,
  Compass,
  Folder as FolderIcon,
  LayoutGrid,
  Map as MapIcon,
  Paintbrush,
  Shield,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';

import { TopBarSearch } from './top-bar-search';
import { UserMenu } from './user-menu';

/**
 * Client wrapper that owns the conditional render of the global
 * chrome (sidebar nav + top bar). Lives separately from AppShell
 * because the path-based suppression has to happen client-side:
 * the previous attempt (read x-gratis-pathname stamped by
 * middleware) lost the header in some prod paths, leaving the
 * search-items chrome stacked on top of the field runtime's own
 * full-bleed UI on mobile.
 *
 * usePathname() always reflects the live route, before and after
 * client-side navigation, so the chrome correctly disappears the
 * instant the user opens a deployment from /field and reappears
 * when they back out.
 *
 * Suppressed routes:
 *   /items/<id>/field         field runtime owns the full screen
 *   /items/<id>/field/...     subroutes (offline shell, etc.)
 *   /items/<id>/viewer/run    web-app viewer
 *   /items/<id>/editor/run    web-app editor
 *   /items/<id>/survey/run    web-app survey runtime
 *   /items/<id>/custom/run    web-app custom runtime
 *   /items/<id>/responses     response viewer
 *   /forms/<id>/respond       respondent-facing form runtime (#345)
 *
 * Everything else gets the full chrome.
 */
export interface AppShellMe {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  orgName: string | null;
  orgRole: 'viewer' | 'contributor' | 'admin';
}

export function AppShellChrome({
  me,
  signedIn,
  fallbackName,
  fallbackEmail,
  children,
}: {
  me: AppShellMe | null;
  signedIn: boolean;
  fallbackName: string | null;
  fallbackEmail: string | null;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? '';

  // Field-runtime path: render bare. Same predicate as the
  // server-side check used to use; kept here so a future widening
  // (e.g. a different full-screen surface) is one regex tweak.
  //
  // Viewer / editor runtimes get the same treatment (#307). They
  // already render their own WAB-style header (title, toolbar,
  // basemap selector); the portal sidebar layered on top of that
  // makes a public-share link look cluttered and breaks AGOL parity.
  // Rendering bare lets a shared link open the runtime as the
  // entire viewport, just like AGOL Web App Builder.
  const isFieldRuntime = /^\/items\/[^/]+\/field(?:\/|$)/.test(pathname);
  // Web-app runtimes that own their own header + chrome. Survey,
  // viewer, editor, and custom each ship a configure-back link in
  // their own header, so layering the portal sidebar on top makes a
  // public-share link feel cluttered and breaks AGOL parity.
  const isAppRuntime =
    /^\/items\/[^/]+\/(?:viewer|editor|survey|custom)\/run(?:\/|$)/.test(
      pathname,
    );
  // Form respondent runtime (#345). The detail page already opens
  // /forms/<id>/respond in a new tab; rendering bare lets the
  // tab stand on its own as a sharable submission surface, the way
  // an AGO Survey123 link does.
  const isFormRespond = /^\/forms\/[^/]+\/respond(?:\/|$)/.test(pathname);
  if (isFieldRuntime || isAppRuntime || isFormRespond) {
    return (
      <div className="min-h-screen bg-surface-0 text-ink-0">{children}</div>
    );
  }

  // Unauthenticated: still no chrome. The page below renders its
  // own header (e.g. PublicLanding's TopBar).
  if (!signedIn) {
    return (
      <div className="min-h-screen bg-surface-0 text-ink-0">{children}</div>
    );
  }

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
          <NavLink
            href="/items?folders=open"
            icon={<FolderIcon className="h-4 w-4" />}
          >
            Folders
          </NavLink>
          <NavLink href="/groups" icon={<Users className="h-4 w-4" />}>Groups</NavLink>
          <NavLink href="/field" icon={<ClipboardList className="h-4 w-4" />}>
            Field
          </NavLink>
          <NavLink href="/recently-deleted" icon={<Trash2 className="h-4 w-4" />}>
            Recently deleted
          </NavLink>
          {me?.orgRole === 'admin' ? (
            <>
              <p className="mt-4 px-2 text-[10px] font-medium uppercase tracking-wide text-muted">
                Admin
              </p>
              <NavLink
                href="/admin/users"
                icon={<Shield className="h-4 w-4" />}
              >
                Users
              </NavLink>
              <NavLink
                href="/admin/branding"
                icon={<Paintbrush className="h-4 w-4" />}
              >
                Landing page
              </NavLink>
              <NavLink
                href="/admin/backup"
                icon={<Archive className="h-4 w-4" />}
              >
                Backup
              </NavLink>
              <NavLink
                href="/admin/housekeeping"
                icon={<Sparkles className="h-4 w-4" />}
              >
                Housekeeping
              </NavLink>
              <NavLink
                href="/admin/notifications"
                icon={<Bell className="h-4 w-4" />}
              >
                Notifications
              </NavLink>
              <NavLink
                href="/admin/field-queues"
                icon={<ClipboardList className="h-4 w-4" />}
              >
                Field queues
              </NavLink>
            </>
          ) : null}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar reserves env(safe-area-inset-top) so iOS status
            bar / dynamic island doesn't sit on top of the user-menu
            button when the app is launched from a home-screen PWA
            install (viewport-fit=cover puts the page under the
            status bar by design). */}
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-surface-0/80 px-4 backdrop-blur pt-[env(safe-area-inset-top)] [height:calc(3.5rem+env(safe-area-inset-top))]">
          <div className="flex flex-1 items-center gap-3">
            <TopBarSearch />
          </div>
          <div className="flex items-center gap-2">
            <button
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-surface-2"
              aria-label="Notifications"
            >
              <Bell className="h-4 w-4" />
            </button>
            {signedIn ? (
              <UserMenu
                seed={me?.id ?? fallbackEmail ?? 'you'}
                displayName={me?.fullName ?? fallbackName ?? 'You'}
                orgName={me?.orgName ?? null}
                avatarUrl={me?.avatarUrl ?? null}
              />
            ) : (
              <Link
                href="/signin"
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
