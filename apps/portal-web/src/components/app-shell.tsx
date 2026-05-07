// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from 'react';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { apiFetch } from '@/lib/api';
import { AppShellChrome, type AppShellMe } from './app-shell-chrome';

/**
 * Server entry point for the global chrome. Fetches the session +
 * the current user's profile (server-only because it uses the
 * Keycloak access token), then hands everything to the client
 * AppShellChrome which decides how to render based on usePathname().
 *
 * The split exists because path-based chrome suppression has to be
 * client-side. We previously stamped x-gratis-pathname from
 * middleware and read it via headers() here, but that header
 * occasionally didn't propagate in prod -- the visible symptom was
 * the search-items top bar stacking on top of the field-runtime's
 * own header on iPhone, eating the vertical room the field
 * footer's "Add feature" button needed. usePathname() is always
 * accurate, so the suppression now lives on the client.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const session = await getServerSession(authOptions);

  let me: AppShellMe | null = null;
  if (session) {
    try {
      me = await apiFetch<AppShellMe>('/api/users/me');
    } catch {
      me = null;
    }
  }

  return (
    <AppShellChrome
      me={me}
      signedIn={!!session}
      fallbackName={session?.user?.name ?? null}
      fallbackEmail={session?.user?.email ?? null}
    >
      {children}
    </AppShellChrome>
  );
}
