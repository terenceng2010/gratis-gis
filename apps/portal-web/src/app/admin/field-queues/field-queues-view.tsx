'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, Smartphone } from 'lucide-react';

import { formatBytes } from '@/lib/offline-store';

/**
 * Per-deployment summary inside a single device's manifest. Mirrors
 * what the API returns; trimmed to what this page renders.
 *
 * The server enriches each entry with `dataCollectionTitle` (resolved
 * via Item.title) so the admin sees a human label rather than a raw
 * uuid. `dataCollectionDeleted` flips when the underlying item has
 * been soft-deleted, since the manifest mirror outlives item deletion
 * by design.
 */
export interface FieldQueueManifestEntry {
  dataCollectionId: string;
  dataCollectionTitle?: string | null;
  dataCollectionDeleted?: boolean;
  cachedAt: string | null;
  queuedRecords: Array<{
    id: string;
    op: 'insert' | 'update' | 'delete';
    layerId: string;
    queuedAt: string;
    status: 'pending' | 'failed';
    lastError?: string | null;
    attempts?: number;
  }>;
}

export interface FieldQueueRow {
  id: string;
  userId: string;
  username: string;
  email: string;
  fullName: string | null;
  deviceFingerprint: string;
  storageUsage: number | null;
  storageQuota: number | null;
  userAgent: string | null;
  reportedAt: string;
  manifest: FieldQueueManifestEntry[];
}

/**
 * Sort and render every device row. We don't try to roll up by user
 * here -- one user with two devices is two rows, deliberately, since
 * the device is the unit of state we can act on (no admin lever
 * mutates state remotely; the unit of recovery is "ask Alice to open
 * her iPad").
 */
export function FieldQueuesView({ rows }: { rows: FieldQueueRow[] }) {
  const sorted = useMemo(() => {
    // Stuck records first (urgent), then oldest report (silent
    // device, possibly worker hasn't opened the app in a while).
    return [...rows].sort((a, b) => {
      const aStuck = countQueued(a);
      const bStuck = countQueued(b);
      if (aStuck !== bStuck) return bStuck - aStuck;
      return a.reportedAt.localeCompare(b.reportedAt);
    });
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-1 px-4 py-10 text-center text-sm text-muted">
        No field devices have reported in yet. Once a worker opens a
        deployment in field mode, their device will beacon a queue
        manifest here.
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {sorted.map((row) => (
        <DeviceRow key={row.id} row={row} />
      ))}
    </ul>
  );
}

function DeviceRow({ row }: { row: FieldQueueRow }) {
  const [expanded, setExpanded] = useState(false);
  const stuck = countQueued(row);
  const failed = countFailed(row);
  const oldest = oldestQueuedAt(row);
  const lastReportMs = Date.now() - new Date(row.reportedAt).getTime();
  const silent = lastReportMs > 1000 * 60 * 60 * 24 * 3; // > 3 days
  const usagePct =
    row.storageQuota && row.storageQuota > 0 && row.storageUsage !== null
      ? (row.storageUsage / row.storageQuota) * 100
      : null;
  const tightStorage = usagePct !== null && usagePct >= 90;

  return (
    <li className="rounded-lg border border-border bg-surface-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-stretch gap-3 px-4 py-3 text-left hover:bg-surface-2"
      >
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent"
        >
          <Smartphone className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h2 className="truncate text-sm font-semibold text-ink-0">
              {row.fullName || row.username}
            </h2>
            <span className="text-xs text-muted">{row.email}</span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted">
            {describeUserAgent(row.userAgent)} · device{' '}
            {row.deviceFingerprint.slice(0, 8)}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
            {stuck > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 font-medium text-amber-700">
                <AlertTriangle className="h-3 w-3" />
                {stuck} queued
                {failed > 0 ? ` (${failed} failed)` : ''}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-700">
                Queue clear
              </span>
            )}
            {oldest ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-muted">
                Oldest queued: {formatRelative(oldest)}
              </span>
            ) : null}
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                silent
                  ? 'border-amber-200 bg-amber-50 text-amber-700'
                  : 'border-border bg-surface-2 text-muted'
              }`}
              title={new Date(row.reportedAt).toLocaleString()}
            >
              Last seen: {formatRelative(row.reportedAt)}
            </span>
            {usagePct !== null ? (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                  tightStorage
                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                    : 'border-border bg-surface-2 text-muted'
                }`}
              >
                Storage: {formatBytes(row.storageUsage ?? 0)} /{' '}
                {formatBytes(row.storageQuota ?? 0)} ({usagePct.toFixed(0)}%)
              </span>
            ) : null}
          </div>
        </div>
        <ChevronRight
          className={`h-4 w-4 self-center text-muted transition-transform ${
            expanded ? 'rotate-90' : ''
          }`}
        />
      </button>

      {expanded ? (
        <div className="border-t border-border px-4 py-3">
          {row.manifest.length === 0 ? (
            <p className="text-xs text-muted">
              No deployments cached on this device.
            </p>
          ) : (
            <ul className="space-y-3">
              {row.manifest.map((entry) => (
                <DeploymentEntry
                  key={entry.dataCollectionId}
                  entry={entry}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}

function DeploymentEntry({ entry }: { entry: FieldQueueManifestEntry }) {
  const queued = entry.queuedRecords.length;
  const failed = entry.queuedRecords.filter((r) => r.status === 'failed');
  // Prefer the server-resolved deployment title. If the item has been
  // soft-deleted we keep the title but tag it; if the lookup missed
  // entirely (cross-org or hard-deleted) we fall back to the uuid so
  // the admin can still copy it for forensic purposes.
  const title = entry.dataCollectionTitle?.trim() || null;
  const deleted = !!entry.dataCollectionDeleted;
  return (
    <li className="rounded-md border border-border bg-surface-0 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          {title ? (
            <Link
              href={`/items/${entry.dataCollectionId}`}
              className="block truncate text-sm font-medium text-ink-0 hover:text-accent"
              title={entry.dataCollectionId}
            >
              {title}
              {deleted ? (
                <span className="ml-2 text-[10px] font-normal text-muted">
                  (deleted)
                </span>
              ) : null}
            </Link>
          ) : (
            <p
              className="truncate text-sm font-medium text-ink-1"
              title={entry.dataCollectionId}
            >
              Unknown deployment
            </p>
          )}
          <p
            className="mt-0.5 truncate font-mono text-[10px] text-muted"
            title={entry.dataCollectionId}
          >
            {entry.dataCollectionId}
          </p>
        </div>
        <p className="shrink-0 text-[10px] text-muted">
          {entry.cachedAt
            ? `cached ${formatRelative(entry.cachedAt)}`
            : 'no cache'}
        </p>
      </div>
      {queued === 0 ? (
        <p className="mt-1 text-[11px] text-muted">No queued records.</p>
      ) : (
        <p className="mt-1 text-[11px] text-ink-1">
          {queued} queued ({failed.length} failed)
        </p>
      )}
      {failed.length > 0 ? (
        <div className="mt-2 space-y-1">
          {failed.slice(0, 5).map((r) => (
            <div
              key={r.id}
              className="rounded border border-danger/20 bg-danger/5 px-2 py-1 text-[10px] text-danger"
            >
              <span className="font-mono">{r.op}</span> · attempts{' '}
              {r.attempts ?? 0}
              {r.lastError ? <span> · {r.lastError}</span> : null}
            </div>
          ))}
          {failed.length > 5 ? (
            <p className="text-[10px] text-muted">
              + {failed.length - 5} more failed records.
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function countQueued(row: FieldQueueRow): number {
  return row.manifest.reduce((sum, e) => sum + e.queuedRecords.length, 0);
}

function countFailed(row: FieldQueueRow): number {
  return row.manifest.reduce(
    (sum, e) => sum + e.queuedRecords.filter((r) => r.status === 'failed').length,
    0,
  );
}

function oldestQueuedAt(row: FieldQueueRow): string | null {
  let oldest: string | null = null;
  for (const e of row.manifest) {
    for (const r of e.queuedRecords) {
      if (!oldest || (r.queuedAt && r.queuedAt < oldest)) {
        oldest = r.queuedAt;
      }
    }
  }
  return oldest;
}

/** Naive UA bucketing. Just enough to render "iPhone Safari" without
 *  pulling in a real UA-parser dependency for an admin view. */
function describeUserAgent(ua: string | null): string {
  if (!ua) return 'unknown device';
  const isiPhone = /iPhone/.test(ua);
  const isiPad = /iPad|Macintosh.*Mobile/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua);
  const isChrome = /Chrome|Chromium/.test(ua) && !/Edg/.test(ua);
  const isFirefox = /Firefox/.test(ua);
  const isEdge = /Edg/.test(ua);

  const device = isiPhone
    ? 'iPhone'
    : isiPad
      ? 'iPad'
      : isAndroid
        ? 'Android'
        : 'Desktop';
  const browser = isEdge
    ? 'Edge'
    : isChrome
      ? 'Chrome'
      : isSafari
        ? 'Safari'
        : isFirefox
          ? 'Firefox'
          : 'browser';
  return `${device} ${browser}`;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
