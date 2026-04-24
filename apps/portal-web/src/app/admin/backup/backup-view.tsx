'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  Info,
  Loader2,
  PlayCircle,
  RotateCcw,
  Trash2,
  XCircle,
} from 'lucide-react';

/**
 * Runtime-configured knobs we show read-only (operators change them
 * via environment, not through the UI — backup config is ops-level).
 */
export interface BackupConfig {
  backupDir: string;
  scheduleCron: string;
  retentionCount: number;
  pgDumpMode: 'host' | 'docker';
  pgDumpDockerContainer: string | null;
  minioBucket: string;
  scheduleDisabled: boolean;
}

/**
 * Wire shape of a BackupRun as returned by the API. sizeBytes is a
 * string because the underlying column is BIGINT; the JSON layer
 * stringifies it to avoid JS precision loss.
 */
export interface BackupRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed';
  filename: string | null;
  sizeBytes: string | null;
  trigger: string;
  startedBy: string | null;
  error: string | null;
}

interface Props {
  initialConfig: BackupConfig;
  initialRuns: BackupRun[];
}

/**
 * Interactive half of /admin/backup. Owns:
 *   - "Run now" button + its in-flight state.
 *   - Auto-polling while any run is still in progress, so the row
 *     flips to succeeded/failed without a manual refresh.
 *   - Delete-with-confirm on each row.
 *   - Download is a plain <a href> to the API — browsers handle
 *     streamed archive responses better than fetch blobs.
 */
export function BackupView({ initialConfig, initialRuns }: Props) {
  const [runs, setRuns] = useState<BackupRun[]>(initialRuns);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const config = initialConfig;

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/portal/admin/backup/runs');
      if (!res.ok) return;
      const body = (await res.json()) as BackupRun[];
      setRuns(body);
    } catch {
      // Swallow — the next poll tick will try again.
    }
  }, []);

  // Poll while any run is still 'running'. Stop when nothing is in
  // flight so we don't keep hitting the API for a page that's just
  // sitting open. 3s is brisk enough that a fast local backup still
  // shows "done" within one poll interval.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const anyRunning = runs.some((r) => r.status === 'running');
    if (anyRunning && !pollRef.current) {
      pollRef.current = setInterval(reload, 3000);
    }
    if (!anyRunning && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [runs, reload]);

  async function handleRunNow() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/portal/admin/backup/runs', {
        method: 'POST',
      });
      if (!res.ok) {
        setError(`Run failed: ${res.status}`);
        return;
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed');
    } finally {
      setRunning(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleting(id);
    setError(null);
    try {
      const res = await fetch(`/api/portal/admin/backup/runs/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError(`Delete failed: ${res.status}`);
        return;
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeleting(null);
      setConfirmingDelete(null);
    }
  }

  return (
    <div className="space-y-6">
      <ConfigPanel config={config} />

      <section className="rounded-lg border border-border bg-surface-1">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-medium text-ink-0">Recent runs</h2>
            <p className="text-xs text-muted">
              History of scheduled and manual backups. Retention keeps the
              latest {config.retentionCount} successful archives; failed
              runs are preserved so you can diagnose them.
            </p>
          </div>
          <button
            type="button"
            onClick={handleRunNow}
            disabled={running}
            className="inline-flex items-center gap-2 rounded-md border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-60"
          >
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PlayCircle className="h-4 w-4" />
            )}
            {running ? 'Starting…' : 'Run now'}
          </button>
        </header>

        {error ? (
          <div className="border-b border-danger/30 bg-danger/5 px-4 py-2 text-xs text-danger">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
            {error}
          </div>
        ) : null}

        {runs.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted">
            No backups yet. Click "Run now" to take your first one, or
            wait for the next scheduled run.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2">Started</th>
                <th className="px-4 py-2">Duration</th>
                <th className="px-4 py-2">Trigger</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Size</th>
                <th className="px-4 py-2">File</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {runs.map((r) => (
                <RunRow
                  key={r.id}
                  run={r}
                  confirming={confirmingDelete === r.id}
                  deleting={deleting === r.id}
                  onConfirmDelete={() => setConfirmingDelete(r.id)}
                  onCancelDelete={() => setConfirmingDelete(null)}
                  onDelete={() => handleDelete(r.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <LimitationsCallout />
    </div>
  );
}

function ConfigPanel({ config }: { config: BackupConfig }) {
  return (
    <section className="rounded-lg border border-border bg-surface-1 p-4">
      <header className="mb-3 flex items-center gap-2">
        <Clock className="h-3.5 w-3.5 text-muted" />
        <h2 className="text-sm font-medium text-ink-0">Configuration</h2>
        <span className="text-xs text-muted">(read-only; set via environment)</span>
      </header>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
        <ConfigRow
          label="Archive directory"
          value={<code className="font-mono">{config.backupDir}</code>}
          hint="BACKUP_DIR"
        />
        <ConfigRow
          label="Schedule"
          value={
            config.scheduleDisabled ? (
              <span className="text-danger">Disabled</span>
            ) : (
              <code className="font-mono">{config.scheduleCron}</code>
            )
          }
          hint="BACKUP_SCHEDULE_CRON"
        />
        <ConfigRow
          label="Retention"
          value={<>{config.retentionCount} successful</>}
          hint="BACKUP_RETENTION_COUNT"
        />
        <ConfigRow
          label="pg_dump"
          value={
            config.pgDumpMode === 'docker' ? (
              <>
                docker exec{' '}
                <code className="font-mono">{config.pgDumpDockerContainer}</code>
              </>
            ) : (
              <>Host binary (pg_dump on PATH)</>
            )
          }
          hint="BACKUP_PGDUMP_DOCKER_CONTAINER"
        />
        <ConfigRow
          label="Object-storage bucket"
          value={<code className="font-mono">{config.minioBucket}</code>}
          hint="MINIO_BUCKET"
        />
      </dl>
    </section>
  );
}

function ConfigRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted">
        {label}
      </dt>
      <dd className="text-ink-0">{value}</dd>
      <dd className="text-[10px] text-muted">{hint}</dd>
    </div>
  );
}

function RunRow({
  run,
  confirming,
  deleting,
  onConfirmDelete,
  onCancelDelete,
  onDelete,
}: {
  run: BackupRun;
  confirming: boolean;
  deleting: boolean;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const started = new Date(run.startedAt);
  const finished = run.finishedAt ? new Date(run.finishedAt) : null;
  const durationMs = finished ? finished.getTime() - started.getTime() : null;
  const size = run.sizeBytes ? formatBytes(BigInt(run.sizeBytes)) : '—';

  return (
    <tr className="hover:bg-surface-2/50">
      <td className="px-4 py-2 text-ink-1">
        <span title={started.toISOString()}>{started.toLocaleString()}</span>
      </td>
      <td className="px-4 py-2 text-muted">
        {durationMs === null ? '—' : formatDuration(durationMs)}
      </td>
      <td className="px-4 py-2">
        <span className="inline-flex items-center rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
          {run.trigger}
        </span>
      </td>
      <td className="px-4 py-2">
        <StatusBadge status={run.status} error={run.error} />
      </td>
      <td className="px-4 py-2 text-muted">{size}</td>
      <td className="px-4 py-2 font-mono text-[11px] text-muted">
        {run.filename ?? '—'}
      </td>
      <td className="px-4 py-2 text-right">
        {confirming ? (
          <span className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={onCancelDelete}
              disabled={deleting}
              className="rounded border border-border bg-surface-1 px-2 py-0.5 text-[11px] text-ink-1 hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={deleting}
              className="inline-flex items-center gap-1 rounded border border-danger bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger hover:bg-danger/20 disabled:opacity-60"
            >
              {deleting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="h-3 w-3" />
              )}
              Delete file
            </button>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            {run.status === 'succeeded' && run.filename ? (
              <a
                href={`/api/portal/admin/backup/runs/${run.id}/download`}
                className="inline-flex items-center gap-1 rounded border border-border bg-surface-1 px-2 py-0.5 text-[11px] text-ink-1 hover:bg-surface-2"
              >
                <Download className="h-3 w-3" />
                Download
              </a>
            ) : null}
            <button
              type="button"
              onClick={onConfirmDelete}
              className="inline-flex items-center gap-1 rounded border border-border bg-surface-1 px-2 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-ink-1"
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </button>
          </span>
        )}
      </td>
    </tr>
  );
}

function StatusBadge({
  status,
  error,
}: {
  status: BackupRun['status'];
  error: string | null;
}) {
  switch (status) {
    case 'running':
      return (
        <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
          <Loader2 className="h-3 w-3 animate-spin" />
          Running
        </span>
      );
    case 'succeeded':
      return (
        <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-800">
          <CheckCircle2 className="h-3 w-3" />
          Succeeded
        </span>
      );
    case 'failed':
      return (
        <span
          className="inline-flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-800"
          title={error ?? undefined}
        >
          <XCircle className="h-3 w-3" />
          Failed
        </span>
      );
  }
}

function LimitationsCallout() {
  return (
    <section className="rounded-lg border border-border bg-surface-0 p-4">
      <header className="mb-2 flex items-center gap-2">
        <Info className="h-3.5 w-3.5 text-muted" />
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
          What's in a backup (and what isn't)
        </h3>
      </header>
      <ul className="list-inside list-disc space-y-1 text-xs text-ink-1">
        <li>
          <span className="font-medium">Included:</span> the GratisGIS
          Postgres database (items, users, groups, shares, basemaps,
          features, snapshots, feature attachments metadata) and every
          object in the configured MinIO bucket (hero images,
          thumbnails, feature attachments).
        </li>
        <li>
          <span className="font-medium">Not included (yet):</span>{' '}
          Keycloak state. The dev configuration stores Keycloak data in
          a file inside the container (ephemeral); production deployments
          with a JDBC Keycloak need a separate snapshot strategy.
        </li>
        <li>
          <span className="font-medium">Not included:</span> secrets
          (.env, Keycloak admin password), Docker compose definitions,
          and TLS material — these live in the deployment repo or your
          secret store.
        </li>
        <li>
          <span className="font-medium">Restore:</span> not yet wired
          into the admin UI. Archives are a standard{' '}
          <code className="font-mono">.tar.gz</code> containing{' '}
          <code className="font-mono">postgres/*.dump</code> (pg_dump
          custom format) and{' '}
          <code className="font-mono">minio/*</code>, so a manual
          pg_restore + bucket sync works today; a guided restore flow is
          tracked as a follow-up.
        </li>
      </ul>
    </section>
  );
}

function formatBytes(n: bigint): string {
  if (n < 1024n) return `${n} B`;
  if (n < 1024n * 1024n) return `${(Number(n) / 1024).toFixed(0)} KB`;
  if (n < 1024n * 1024n * 1024n) return `${(Number(n) / 1024 / 1024).toFixed(1)} MB`;
  return `${(Number(n) / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}
