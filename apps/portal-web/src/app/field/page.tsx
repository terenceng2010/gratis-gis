import Link from 'next/link';
import { ClipboardList } from 'lucide-react';
import type { ItemWithShares } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
import { FieldCatalog, type FieldDeploymentRow } from './field-catalog';

/**
 * Field catalog landing page (Slice 7 of the Field Maps arc; see
 * docs/field-offline-areas.md). The dedicated lens for field
 * deployments. Lists every `data_collection` item the user has
 * access to, with per-row offline-cache state and queued-edit
 * count layered in client-side.
 *
 * This sits alongside the generic items list rather than replacing
 * it. The items list is the everything view; this is the field
 * worker's "what am I working on today" view, mirroring how Field
 * Maps gives map workers a curated map list separate from the
 * generic content browser.
 *
 * The cache and queue surfaces are read from IndexedDB so they
 * have to land on the client. The server component fetches the
 * deployment metadata (title, owner, mapId, share count) since
 * those are auth-gated; the client mounts and walks
 * `listDeployments()` and `listQueue()` for the device-local view.
 */
export default async function FieldCatalogPage() {
  // Pull every data_collection item the user has access to. The
  // multi-type filter on /api/portal/items (#51) makes this a
  // single round-trip; we forward the rows verbatim and let the
  // client component merge the IDB-side state.
  let deployments: ItemWithShares[] = [];
  try {
    deployments = await apiFetch<ItemWithShares[]>(
      '/api/items?type=data_collection',
    );
  } catch {
    // Non-fatal: the page renders an empty state below. A network
    // failure here usually means the user signed out in another
    // tab; the empty state's primary action takes them home, which
    // re-runs auth.
    deployments = [];
  }

  const rows: FieldDeploymentRow[] = deployments.map((item) => ({
    id: item.id,
    title: item.title,
    description: item.description,
    ownerLabel: typeof item.owner === 'string' ? item.owner : null,
    updatedAt: item.updatedAt,
    // The data_collection's bound map id, when present. Resolved
    // client-side to "Map: <map title>" (the client already pulls
    // the deployment manifest for cache state, so adding a map
    // title would mean either a per-row API call here or a join
    // we don't have today; we punt to the runtime page).
    mapId:
      (item.data as { mapId?: string } | null)?.mapId &&
      typeof (item.data as { mapId?: string }).mapId === 'string'
        ? (item.data as { mapId: string }).mapId
        : null,
  }));

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      {/* Mobile: just the title -- this is a field worker's
          launchpad, nothing else. The descriptive copy and the
          "New deployment" button are author affordances and only
          surface from sm: up. Saves vertical real estate on
          iPhone where every row of the deployment list matters
          more than the marketing line. */}
      <header className="mb-4 flex items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">Content</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Field
          </h1>
          <p className="mt-1 hidden text-sm text-muted sm:block">
            Deployments you can open in the field, with offline-cache and
            sync state for this device.
          </p>
        </div>
        <Link
          href="/items/new?type=data_collection"
          className="hidden h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 sm:inline-flex"
        >
          <ClipboardList className="h-4 w-4" />
          New deployment
        </Link>
      </header>

      {rows.length === 0 ? (
        <EmptyState
          icon={<ClipboardList className="h-5 w-5" />}
          title="No field deployments yet"
          description="A field deployment points at a map and the form workers fill out when they add features. Create one to start collecting data in the field."
          action={
            <Link
              href="/items/new?type=data_collection"
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
            >
              <ClipboardList className="h-4 w-4" />
              Create a deployment
            </Link>
          }
        />
      ) : (
        <FieldCatalog rows={rows} />
      )}
    </div>
  );
}
