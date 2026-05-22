// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  LogIn,
  LogOut,
  Plus,
  Search,
  Upload,
} from 'lucide-react';
import {
  ORG_URL_STORAGE_KEY,
  SHARING_BASE_STORAGE_KEY,
  STATE_STORAGE_KEY,
  TOKEN_CHANNEL_NAME,
} from './oauth-storage-keys';

interface AgoConnection {
  id: string;
  orgUrl: string;
  orgHost: string;
  displayName: string;
  clientId: string;
  createdAt: string;
  createdById: string;
}

interface DryRunItem {
  agoId: string;
  agoType: string;
  title: string;
  folderTitle: string;
  willImport: boolean;
  targetType: string | null;
  reason?: string;
  serviceUrl?: string;
  access?: string;
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
    byAccess?: Record<string, number>;
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

interface ImportedFolder {
  agoFolderId: string;
  title: string;
  portalItemId: string;
  childCount: number;
}

interface ImportReport {
  total: number;
  created: number;
  failed: number;
  skipped: number;
  results: ImportResult[];
  folders: ImportedFolder[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

interface SessionState {
  token: string;
  sharingRestBase: string;
  connectionDisplayName: string;
  expiresAtMs: number;
}

export function FromAgoView() {
  const [conns, setConns] = useState<AgoConnection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [session, setSession] = useState<SessionState | null>(null);
  const [preview, setPreview] = useState<DryRunReport | null>(null);
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState<'auth' | 'preview' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);

  // Load the connections list once on mount.
  useEffect(() => {
    void (async () => {
      try {
        const resp = await fetch(
          '/api/portal/admin/import-ago/connections',
        );
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} ${await resp.text()}`);
        }
        const list = (await resp.json()) as AgoConnection[];
        setConns(list);
        if (list.length > 0 && !selectedId) setSelectedId(list[0]!.id);
      } catch (e) {
        setLoadError((e as Error).message);
      }
    })();
    // selectedId intentionally omitted from deps: we only auto-pick
    // on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // OAuth popup token handoff via BroadcastChannel.
  //
  // The previous shape used window.opener.postMessage; that
  // breaks under modern COOP on the cross-origin hop through AGO
  // (window.opener becomes null in the popup after the redirect
  // returns). BroadcastChannel is same-origin-only by spec, so
  // security stays intact, and it survives the cross-origin
  // navigation that severs opener.
  //
  // A window.addEventListener('message') fallback is kept for the
  // happy path where opener does survive (some browsers) -- both
  // paths produce the same effect so a duplicate delivery is a
  // no-op.
  useEffect(() => {
    function handlePayload(data: {
      type?: string;
      token?: string;
      state?: string;
      expiresIn?: number;
      receivedAt?: number;
    } | null) {
      if (!data || data.type !== 'gratisgis:ago-oauth-token') return;
      if (!data.token) {
        setError('OAuth popup returned no token.');
        setBusy(null);
        return;
      }
      // Idempotency: a popup that fires both the BroadcastChannel
      // and the postMessage paths should not double-set state. If
      // we already have a session, ignore the second delivery.
      if (session) return;
      const sharingRestBase =
        window.sessionStorage.getItem(SHARING_BASE_STORAGE_KEY) ?? '';
      const displayName =
        window.sessionStorage.getItem(ORG_URL_STORAGE_KEY) ?? '';
      const expiresIn = Number(data.expiresIn) || 3600;
      const receivedAt = Number(data.receivedAt) || Date.now();
      setSession({
        token: data.token,
        sharingRestBase,
        connectionDisplayName: displayName,
        expiresAtMs: receivedAt + expiresIn * 1000,
      });
      setBusy(null);
      setError(null);
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
      popupRef.current = null;
    }

    // Primary path: BroadcastChannel. Same-origin only.
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(TOKEN_CHANNEL_NAME);
      channel.addEventListener(
        'message',
        (event: MessageEvent<unknown>) => {
          handlePayload(
            event.data as Parameters<typeof handlePayload>[0],
          );
        },
      );
    } catch {
      // Ancient browser without BroadcastChannel; the
      // postMessage fallback below still gets a chance.
    }

    // Fallback path: window.opener.postMessage. Only delivers
    // when COOP didn't sever the opener relationship (still true
    // on same-origin popups in many browsers).
    function onMessage(event: MessageEvent<unknown>) {
      if (event.origin !== window.location.origin) return;
      handlePayload(event.data as Parameters<typeof handlePayload>[0]);
    }
    window.addEventListener('message', onMessage);

    return () => {
      window.removeEventListener('message', onMessage);
      channel?.close();
    };
  }, [session]);

  async function signIn() {
    if (!selectedId) {
      setError('Pick a connection first.');
      return;
    }
    setBusy('auth');
    setError(null);
    setPreview(null);
    setImportReport(null);
    try {
      const redirectUri = `${window.location.origin}/admin/migrations/from-ago/oauth-callback`;
      const resp = await fetch('/api/portal/admin/import-ago/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: selectedId, redirectUri }),
      });
      if (!resp.ok) {
        throw new Error(
          `OAuth start failed: HTTP ${resp.status} ${await resp.text()}`,
        );
      }
      const data = (await resp.json()) as {
        authorizeUrl: string;
        sharingRestBase: string;
        state: string;
        connection: AgoConnection;
      };
      window.sessionStorage.setItem(STATE_STORAGE_KEY, data.state);
      window.sessionStorage.setItem(
        SHARING_BASE_STORAGE_KEY,
        data.sharingRestBase,
      );
      window.sessionStorage.setItem(
        ORG_URL_STORAGE_KEY,
        data.connection.displayName,
      );

      const w = 540;
      const h = 700;
      const left = window.screenX + (window.outerWidth - w) / 2;
      const top = window.screenY + (window.outerHeight - h) / 2;
      const popup = window.open(
        data.authorizeUrl,
        'gratisgis-ago-oauth',
        `popup=1,width=${w},height=${h},left=${Math.round(left)},top=${Math.round(top)}`,
      );
      if (!popup) {
        throw new Error(
          'Popup blocked. Allow popups for this site and try again.',
        );
      }
      popupRef.current = popup;
      // No popup.closed polling here: under COOP (especially in
      // Edge / Chrome) `popup.closed` returns true the instant the
      // popup navigates cross-origin to AGO, well before the user
      // has signed in. The token handoff via BroadcastChannel is
      // the authoritative success signal; for the "user closed
      // the popup without signing in" path, the long-timeout
      // safety net below + the manual Cancel button reset busy
      // state without false positives.
      window.setTimeout(
        () => {
          if (popupRef.current === popup) {
            setBusy(null);
            setError(
              'Sign-in did not complete within 10 minutes. Try again.',
            );
            popupRef.current = null;
          }
        },
        10 * 60 * 1000,
      );
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Manual cancel for the sign-in popup. The popup itself stays
   *  open (closing it under COOP requires the popup's own context),
   *  but the opener stops waiting and the user can dismiss the
   *  popup themselves. */
  function cancelSignIn() {
    if (busy !== 'auth') return;
    setBusy(null);
    setError(null);
    // Best-effort: close the popup if we still hold a reference
    // the browser will honour. Under strict COOP this no-ops.
    try {
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
    } catch {
      /* COOP blocked the close; user closes the popup manually */
    }
    popupRef.current = null;
  }

  function signOut() {
    setSession(null);
    setPreview(null);
    setImportReport(null);
    setError(null);
    window.sessionStorage.removeItem(SHARING_BASE_STORAGE_KEY);
    window.sessionStorage.removeItem(ORG_URL_STORAGE_KEY);
  }

  async function runPreview() {
    if (!session) return;
    setBusy('preview');
    setError(null);
    setImportReport(null);
    try {
      const resp = await fetch('/api/portal/admin/import-ago/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portalUrl: session.sharingRestBase,
          token: session.token,
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
    if (!preview || !session) return;
    setBusy('run');
    setError(null);
    try {
      const resp = await fetch('/api/portal/admin/import-ago/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portalUrl: session.sharingRestBase,
          token: session.token,
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
        {session ? (
          <SignedInPanel
            session={session}
            onSignOut={signOut}
            busy={busy}
            onPreview={runPreview}
            onRun={runImport}
            canRun={!!preview}
          />
        ) : (
          <PickConnectionPanel
            conns={conns}
            loadError={loadError}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onSignIn={signIn}
            onCancelSignIn={cancelSignIn}
            busy={busy}
          />
        )}
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
                    <th className="px-2 py-1.5 font-medium">Sharing</th>
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
                      <td className="px-2 py-1.5 text-muted">
                        {row.access ?? ''}
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
            {importReport.folders.length > 0 ? (
              <>
                {' '}
                Created {importReport.folders.length} folder(s) mirroring the
                AGO layout.
              </>
            ) : null}
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <Counter label="Created" value={importReport.created} tone="ok" />
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

function PickConnectionPanel({
  conns,
  loadError,
  selectedId,
  onSelect,
  onSignIn,
  onCancelSignIn,
  busy,
}: {
  conns: AgoConnection[] | null;
  loadError: string | null;
  selectedId: string;
  onSelect: (id: string) => void;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  busy: 'auth' | 'preview' | 'run' | null;
}) {
  if (loadError) {
    return (
      <div className="rounded border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
        Failed to load AGO connections: {loadError}
      </div>
    );
  }
  if (conns === null) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading AGO connections...
      </p>
    );
  }
  if (conns.length === 0) {
    return (
      <>
        <h2 className="text-base font-semibold">No AGO connections yet</h2>
        <p className="mt-1 text-xs text-muted">
          Register at least one AGO portal before importing. One-time
          setup; afterwards sign-in is one click.
        </p>
        <Link
          href="/admin/migrations/from-ago/connections"
          className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
        >
          <Plus className="h-4 w-4" />
          Add AGO connection
        </Link>
      </>
    );
  }
  return (
    <>
      <h2 className="text-base font-semibold">Sign in to ArcGIS Online</h2>
      <p className="mb-4 mt-1 text-xs text-muted">
        Pick which AGO portal to import from. The sign-in happens in
        a popup; the token never leaves this portal.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-muted">AGO connection</span>
        <select
          value={selectedId}
          onChange={(e) => onSelect(e.target.value)}
          className="rounded border border-border bg-surface-0 px-2 py-1.5 text-sm"
        >
          {conns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName} ({c.orgHost})
            </option>
          ))}
        </select>
      </label>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={!selectedId || busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          onClick={onSignIn}
        >
          {busy === 'auth' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <LogIn className="h-4 w-4" />
          )}
          {busy === 'auth' ? 'Waiting for sign-in...' : 'Sign in to ArcGIS Online'}
        </button>
        {busy === 'auth' && (
          <button
            type="button"
            onClick={onCancelSignIn}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-0 px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-2 hover:text-ink-0"
          >
            Cancel
          </button>
        )}
      </div>
    </>
  );
}

function SignedInPanel({
  session,
  onSignOut,
  busy,
  onPreview,
  onRun,
  canRun,
}: {
  session: SessionState;
  onSignOut: () => void;
  busy: 'auth' | 'preview' | 'run' | null;
  onPreview: () => void;
  onRun: () => void;
  canRun: boolean;
}) {
  const minutesLeft = Math.max(
    0,
    Math.floor((session.expiresAtMs - Date.now()) / 60000),
  );
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">
            Connected to {session.connectionDisplayName}
          </h2>
          <p className="mt-1 text-xs text-muted">
            token expires in ~{minutesLeft} min
          </p>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-0 px-2 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-ink-0"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
      </div>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-0 px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
          onClick={onPreview}
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
          disabled={!canRun || busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          onClick={onRun}
        >
          {busy === 'run' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          Run import
        </button>
      </div>
    </>
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
    <div className={`rounded border px-3 py-2 ${toneClasses[tone]}`}>
      <p className="text-xs opacity-80">{label}</p>
      <p className="text-xl font-semibold">{value}</p>
    </div>
  );
}
