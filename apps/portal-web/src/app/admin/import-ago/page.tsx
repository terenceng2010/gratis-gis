// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, DownloadCloud } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { ImportAgoView } from './import-ago-view';

/**
 * Admin-only AGO migration page. Pastes an AGO portal URL +
 * token, runs a dry-run preview, then commits the import on a
 * second click. Kept synchronous on the server side because
 * the API endpoints are admin-gated and the calling user
 * needs to be admin too.
 */
export default async function AdminImportAgoPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link
        href="/items"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to portal
      </Link>
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <DownloadCloud className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs text-muted">Admin</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Import from ArcGIS Online
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            Mirror Web Maps, hosted services, tile layers, and file
            attachments from an AGO portal into GratisGIS. Apps,
            dashboards, and forms are deliberately not imported -- those
            need to be rebuilt in the portal because their runtimes
            don&apos;t translate cleanly.
          </p>
        </div>
      </header>
      <ImportAgoView />
    </div>
  );
}
