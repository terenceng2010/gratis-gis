import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, Layers3 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { AdminBasemapsView } from './admin-basemaps-view';

export type BasemapSourceKind = 'xyz' | 'vector-style' | 'wms';

export interface BasemapRow {
  id: string;
  orgId: string;
  label: string;
  description: string;
  url: string;
  sourceKind: BasemapSourceKind;
  attribution: string;
  thumbnailUrl: string | null;
  config: Record<string, unknown> | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export default async function AdminBasemapsPage() {
  let me: { orgRole: string };
  try {
    me = await apiFetch<{ orgRole: string }>('/api/users/me');
  } catch {
    redirect('/items');
  }
  if (me.orgRole !== 'admin') redirect('/items');

  let basemaps: BasemapRow[] = [];
  try {
    basemaps = await apiFetch<BasemapRow[]>('/api/basemaps');
  } catch {
    basemaps = [];
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <Link
        href="/items"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to portal
      </Link>
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
          <Layers3 className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs text-muted">Admin</p>
          <h1 className="text-2xl font-semibold tracking-tight">Basemaps</h1>
          <p className="mt-0.5 text-sm text-muted">
            Register XYZ raster tile servers, vector style URLs, or WMS
            endpoints. These appear in the web map editor&apos;s picker
            alongside the built-in set. One may be marked default.
          </p>
        </div>
      </header>

      <AdminBasemapsView initialBasemaps={basemaps} />
    </div>
  );
}
