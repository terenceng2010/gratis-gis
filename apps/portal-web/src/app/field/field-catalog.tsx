'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  CloudDownload,
  CloudOff,
  ClipboardList,
  ChevronRight,
  Loader2,
  Wifi,
} from 'lucide-react';
import {
  formatBytes,
  listDeployments,
  listQueue,
  type CachedDeployment,
} from '@/lib/offline-store';
import { syncQueue } from '@/lib/offline-sync';

/**
 * Server-side row shape we get from page.tsx. Mirrors the slice of
 * ItemWithShares the catalog actually consumes; we don't carry the
 * full item to keep the bundle small. The client merges this with
 * IDB-side state on mount.
 */
export interface FieldDeploymentRow {
  id: string;
  title: string;
  description: string;
  ownerLabel: string | null;
  updatedAt: string;
  mapId: string | null;
}

/**
 * Per-deployment overlay we compute client-side. The cache state is
 * read from IndexedDB; queue counts come from the queue store. Both
 * are scoped per deployment id; both are zero / null when the user
 * hasn't downloaded this deployment yet.
 */
interface DeploymentOverlay {
  cached: CachedDeployment | null;
  queueCount: number;
}

/**
 * Catalog body. Renders one row per deployment with cache + queue
 * state surfaced inline. Per-row affordances:
 *
 *   - "Open" link to the runtime (always available).
 *   - "Sync N" button when records are queued and the device is
 *     online. Drains just that deployment's queue.
 *   - "Cached / Not cached" indicator with size + age.
 *
 * The catalog itself doesn't hold any storage estimate -- the
 * runtime header does that for the active deployment. Per-deployment
 * size from the manifest is enough here.
 */
export function FieldCatalog({ rows }: { rows: FieldDeploymentRow[] }) {
  const [overlays, setOverlays] = useState<Record<string, DeploymentOverlay>>(
    {},
  );
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [syncing, setSyncing] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onUp = () => setIsOnline(true);
    const onDown = () => setIsOnline(false);
    window.addEventListener('online', onUp);
    window.addEventListener('offline', onDown);
    return () => {
      window.removeEventListener('online', onUp);
      window.removeEventListener('offline', onDown);
    };
  }, []);

  // Initial load: walk every cached deployment + every queue read
  // once so the rows render with current state. Cheap (a few
  // IndexedDB reads); no need to fan these out as the user
  // navigates.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cachedList = await listDeployments();
      const cachedById = new Map(
        cachedList.map((c) => [c.dataCollectionId, c]),
      );
      const next: Record<string, DeploymentOverlay> = {};
      for (const row of rows) {
        const queue = await listQueue(row.id);
        next[row.id] = {
          cached: cachedById.get(row.id) ?? null,
          queueCount: queue.length,
        };
      }
      if (!cancelled) setOverlays(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  async function syncOne(id: string) {
    setSyncing((prev) => ({ ...prev, [id]: true }));
    try {
      await syncQueue(id);
      // Refresh the row's queue count after the run.
      const remaining = await listQueue(id);
      setOverlays((prev) => ({
        ...prev,
        [id]: {
          ...(prev[id] ?? { cached: null, queueCount: 0 }),
          queueCount: remaining.length,
        },
      }));
    } finally {
      setSyncing((prev) => ({ ...prev, [id]: false }));
    }
  }

  // Sort: deployments with queued edits float to the top (the user
  // most likely wants to see those), then by updatedAt desc.
  const sorted = [...rows].sort((a, b) => {
    const qa = overlays[a.id]?.queueCount ?? 0;
    const qb = overlays[b.id]?.queueCount ?? 0;
    if (qa !== qb) return qb - qa;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return (
    <div className="space-y-4">
      {/* Connectivity banner: a thin reminder at the top so the
          worker knows whether sync is going to run on tap. */}
      <div
        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
          isOnline
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'border-amber-200 bg-amber-50 text-amber-700'
        }`}
      >
        {isOnline ? (
          <>
            <Wifi className="h-3.5 w-3.5" />
            <span>Online. Tap a deployment to open.</span>
          </>
        ) : (
          <>
            <CloudOff className="h-3.5 w-3.5" />
            <span>
              Offline. Cached deployments are still openable; queued edits
              will sync when you reconnect.
            </span>
          </>
        )}
      </div>

      <ul className="divide-y divide-border rounded-md border border-border bg-surface-1">
        {sorted.map((row) => {
          const overlay = overlays[row.id] ?? {
            cached: null,
            queueCount: 0,
          };
          return (
            <li key={row.id} className="flex items-stretch gap-2 p-3">
              <span
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent"
              >
                <ClipboardList className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold text-ink-0">
                  {row.title}
                </h2>
                {row.description ? (
                  <p className="truncate text-[11px] text-muted">
                    {row.description}
                  </p>
                ) : null}
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                  {overlay.cached ? (
                    <span
                      className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-700"
                      title={`Cached on ${new Date(overlay.cached.cachedAt).toLocaleString()}`}
                    >
                      <CloudDownload className="h-3 w-3" />
                      Cached · {formatBytes(overlay.cached.estimatedSize)}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-muted">
                      Not cached
                    </span>
                  )}
                  {overlay.queueCount > 0 ? (
                    isOnline ? (
                      <button
                        type="button"
                        disabled={syncing[row.id]}
                        onClick={() => {
                          void syncOne(row.id);
                        }}
                        className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-700 hover:bg-amber-100 disabled:opacity-60"
                      >
                        {syncing[row.id] ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <CloudDownload className="h-3 w-3 rotate-180" />
                        )}
                        {syncing[row.id]
                          ? 'Syncing...'
                          : `Sync ${overlay.queueCount}`}
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-muted">
                        <CloudOff className="h-3 w-3" />
                        {overlay.queueCount} queued
                      </span>
                    )
                  ) : null}
                </div>
              </div>
              <Link
                href={`/items/${row.id}/field?from=field`}
                className="flex shrink-0 items-center gap-1 self-center rounded-md border border-border bg-surface-0 px-3 py-2 text-xs font-medium text-ink-0 hover:border-accent hover:text-accent"
              >
                Open
                <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
