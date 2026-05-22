// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Search,
  Upload,
} from 'lucide-react';

interface DryRunItem {
  agoId: string;
  agoType: string;
  title: string;
  folderTitle: string;
  willImport: boolean;
  targetType: string | null;
  reason?: string;
  serviceUrl?: string;
}

interface DryRunReport {
  portal: { url: string; username: string };
  generatedAt: string;
  counts: {
    foldersTotal: number;
    itemsTotal: number;
    itemsToImport: number;
    itemsToSkip: number;
    byTargetType: Record<string, number>;
    byAgoType: Record<string, number>;
  };
  folders: Array<{ id: string; title: string }>;
  items: DryRunItem[];
  warnings: Array<{ severity: 'info' | 'warn'; message: string }>;
}

interface ImportResult {
  agoId: string;
  agoType: string;
  agoTitle: string;
  status: 'created' | 'failed' | 'skipped';
  portalItemId?: string;
  portalItemType?: string;
  warnings: string[];
  error?: string;
}

interface ImportReport {
  total: number;
  created: number;
  failed: number;
  skipped: number;
  results: ImportResult[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export function ImportAgoView() {
  const [portalUrl, setPortalUrl] = useState(
    'https://www.arcgis.com/sharing/rest',
  );
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [preview, setPreview] = useState<DryRunReport | null>(null);
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState<'preview' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runPreview() {
    setBusy('preview');
    setError(null);
    setImportReport(null);
    try {
      const resp = await fetch('/api/portal/admin/import-ago/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portalUrl: portalUrl.trim(),
          token: token.trim(),
          ...(username.trim() ? { username: username.trim() } : {}),
        }),
      });
      if (!resp.ok) {
        throw new Error(
          `Preview failed: HTTP ${resp.status} ${await resp.text()}`,
        );
      }
      setPreview((await resp.json()) as DryRunReport);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function runImport() {
    if (!preview) return;
    setBusy('run');
    setError(null);
    try {
      const resp = await fetch('/api/portal/admin/import-ago/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portalUrl: portalUrl.trim(),
          token: token.trim(),
          report: preview,
        }),
      });
      if (!resp.ok) {
        throw new Error(
          `Import failed: HTTP ${resp.status} ${await resp.text()}`,
        );
      }
      setImportReport((await resp.json()) as ImportReport);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-surface-1 p-5 shadow-card">
        <h2 className="text-base font-semibold">Connection</h2>
        <p className="mb-4 mt-1 text-xs text-muted">
          Paste an AGO portal sharing-API root + an access token. The
          token isn&apos;t stored on the portal; it&apos;s used for this
          session only.
        </p>
        <div className="grid gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted">
              Portal URL (ends in /sharing/rest)
            </span>
            <input
              type="text"
              className="rounded border border-border bg-surface-0 px-2 py-1.5 text-sm"
              value={portalUrl}
              onChange={(e) => setPortalUrl(e.target.value)}
              placeholder="https://www.arcgis.com/sharing/rest"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted">Token</span>
            <input
              type="password"
              className="rounded border border-border bg-surface-0 px-2 py-1.5 text-sm"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Long-lived token from AGO"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted">
              Username (optional; defaults to the token&apos;s owner)
            </span>
            <input
              type="text"
              className="rounded border border-border bg-surface-0 px-2 py-1.5 text-sm"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="alice"
            />
          </label>
        </div>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={!portalUrl.trim() || !token.trim() || busy !== null}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-0 px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
            onClick={runPreview}
          >
            {busy === 'preview' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            Preview what will be imported
          </button>
          <button
            type="button"
            disabled={!preview || busy !== null}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            onClick={runImport}
          >
            {busy === 'run' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            Run import
          </button>
        </div>
        {error && (
          <p className="mt-3 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
      </section>

      {preview && (
        <section className="rounded-lg border border-border bg-surface-1 p-5 shadow-card">
          <h2 className="text-base font-semibold">Preview</h2>
          <p className="mt-1 text-xs text-muted">
            Walked {preview.counts.itemsTotal} item(s) across{' '}
            {preview.counts.foldersTotal} folder(s) belonging to{' '}
            <span className="font-mono">{preview.portal.username}</span>.
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <Counter
              label="Will import"
              value={preview.counts.itemsToImport}
              tone="ok"
            />
            <Counter
              label="Will skip"
              value={preview.counts.itemsToSkip}
              tone="warn"
            />
            <Counter
              label="Folders"
              value={preview.counts.foldersTotal}
              tone="neutral"
            />
          </div>
          {preview.warnings.length > 0 && (
            <ul className="mt-4 space-y-1.5">
              {preview.warnings.map((w, i) => (
                <li
                  key={i}
                  className={`flex items-start gap-2 rounded border px-3 py-2 text-xs ${
                    w.severity === 'warn'
                      ? 'border-warning/30 bg-warning/5 text-warning'
                      : 'border-border bg-surface-0 text-ink-1'
                  }`}
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{w.message}</span>
                </li>
              ))}
            </ul>
          )}
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-muted hover:text-ink-0">
              Per-item detail
            </summary>
            <div className="mt-2 max-h-72 overflow-y-auto rounded border border-border bg-surface-0">
              <table className="w-full text-xs">
                <thead className="bg-surface-2 text-left">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Title</th>
                    <th className="px-2 py-1.5 font-medium">AGO type</th>
                    <th className="px-2 py-1.5 font-medium">Folder</th>
                    <th className="px-2 py-1.5 font-medium">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.items.map((row) => (
                    <tr
                      key={row.agoId}
                      className="border-t border-border align-top"
                    >
                      <td className="px-2 py-1.5">{row.title}</td>
                      <td className="px-2 py-1.5 font-mono text-muted">
                        {row.agoType}
                      </td>
                      <td className="px-2 py-1.5 text-muted">
                        {row.folderTitle}
                      </td>
                      <td className="px-2 py-1.5">
                        {row.willImport ? (
                          <span className="text-success">
                            -&gt; {row.targetType}
                          </span>
                        ) : (
                          <span className="text-warning">
                            skip - {row.reason ?? 'no reason'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      )}

      {importReport && (
        <section className="rounded-lg border border-border bg-surface-1 p-5 shadow-card">
          <h2 className="text-base font-semibold">Import results</h2>
          <p className="mt-1 text-xs text-muted">
            Completed in {(importReport.durationMs / 1000).toFixed(1)} s.
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <Counter
              label="Created"
              value={importReport.created}
              tone="ok"
            />
            <Counter
              label="Failed"
              value={importReport.failed}
              tone={importReport.failed > 0 ? 'error' : 'neutral'}
            />
            <Counter
              label="Skipped"
              value={importReport.skipped}
              tone="warn"
            />
          </div>
          <div className="mt-4 max-h-96 overflow-y-auto rounded border border-border bg-surface-0">
            <table className="w-full text-xs">
              <thead className="bg-surface-2 text-left">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Title</th>
                  <th className="px-2 py-1.5 font-medium">AGO type</th>
                  <th className="px-2 py-1.5 font-medium">Status</th>
                  <th className="px-2 py-1.5 font-medium">Portal item</th>
                  <th className="px-2 py-1.5 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {importReport.results.map((row, i) => (
                  <tr key={i} className="border-t border-border align-top">
                    <td className="px-2 py-1.5">{row.agoTitle}</td>
                    <td className="px-2 py-1.5 font-mono text-muted">
                      {row.agoType}
                    </td>
                    <td className="px-2 py-1.5">
                      {row.status === 'created' && (
                        <span className="inline-flex items-center gap-1 text-success">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          created
                        </span>
                      )}
                      {row.status === 'failed' && (
                        <span className="text-danger">failed</span>
                      )}
                      {row.status === 'skipped' && (
                        <span className="text-warning">skipped</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-muted">
                      {row.portalItemId ? (
                        <a
                          className="hover:underline"
                          href={`/items/${row.portalItemId}`}
                        >
                          {row.portalItemId.slice(0, 8)}...
                        </a>
                      ) : (
                        ''
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-muted">
                      {row.error ?? row.warnings.join('; ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'ok' | 'warn' | 'error' | 'neutral';
}) {
  const toneClasses: Record<typeof tone, string> = {
    ok: 'border-success/30 bg-success/5 text-success',
    warn: 'border-warning/30 bg-warning/5 text-warning',
    error: 'border-danger/30 bg-danger/5 text-danger',
    neutral: 'border-border bg-surface-0 text-ink-0',
  };
  return (
    <div
      className={`rounded border px-3 py-2 ${toneClasses[tone]}`}
    >
      <p className="text-xs opacity-80">{label}</p>
      <p className="text-xl font-semibold">{value}</p>
    </div>
  );
}
