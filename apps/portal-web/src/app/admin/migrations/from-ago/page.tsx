// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, CloudDownload } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { FromAgoView } from './from-ago-view';

/**
 * Admin-only "Migrate from ArcGIS Online" page. The user signs
 * into AGO via an OAuth popup (no token paste), the dry-run
 * previews what will be imported, and a second click commits.
 */
export default async function AdminMigrateFromAgoPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');

  // Read OAuth config once on the server so the client knows
  // whether the Sign-In button can do anything before rendering.
  let oauthConfig: {
    configured: boolean;
    clientId: string | null;
    reason: string | null;
  };
  try {
    oauthConfig = await apiFetch<{
      configured: boolean;
      clientId: string | null;
      reason: string | null;
    }>('/api/admin/import-ago/oauth/config');
  } catch {
    oauthConfig = {
      configured: false,
      clientId: null,
      reason: 'OAuth config endpoint unreachable.',
    };
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link
        href="/admin/migrations"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to migrations
      </Link>
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <CloudDownload className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs text-muted">Migrations / Import</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            From ArcGIS Online
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            Sign in to ArcGIS Online, preview what will be imported,
            then commit. Folder layout and per-item sharing scope are
            preserved. Apps, dashboards, and forms are skipped; their
            runtimes don&apos;t round-trip cleanly.
          </p>
        </div>
      </header>
      <FromAgoView oauthConfig={oauthConfig} />
    </div>
  );
}
