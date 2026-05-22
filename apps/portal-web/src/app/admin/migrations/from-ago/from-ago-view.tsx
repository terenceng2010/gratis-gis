// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CloudDownload,
  Loader2,
  LogIn,
  LogOut,
  Search,
  Upload,
} from 'lucide-react';
import {
  ORG_URL_STORAGE_KEY,
  SHARING_BASE_STORAGE_KEY,
  STATE_STORAGE_KEY,
} from './oauth-storage-keys';

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
  /** AGO access token captured from the OAuth popup. */
  token: string;
  /** Canonical /sharing/rest base the importer should hit. */
  sharingRestBase: string;
  /** Original org URL the user pasted -- shown in the UI so
   *  they can confirm they signed into the right portal. */
  orgUrl: string;
  /** Wall-clock ms when the token expires. Computed from the
   *  popup callback's `expiresIn` so we don't trust client
   *  clocks drifting between the popup and this page. */
  expiresAtMs: number;
}

export function FromAgoView({
  oauthConfig,
}: {
  oauthConfig: {
    configured: boolean;
    clientId: string | null;
    reason: string | null;
  };
}) {
  const [orgUrl, setOrgUrl] = useState('');
  const [session, setSession] = useState<SessionState | null>(null);
  const [preview, setPreview] = useState<DryRunReport | null>(null);
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState<'auth' | 'preview' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);

  // Listen for the token-postMessage from the OAuth popup. The
  // popup is a same-origin page (we control it), so we still
  // require the origin to match ours to keep an extension /
  // sibling iframe from spoofing.
  useEffect(() => {
    function onMessage(event: MessageEvent<unknown>) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as
        | {
            type?: string;
            token?: string;
            state?: string;
            expiresIn?: number;
            receivedAt?: number;
          }
        | null;
      if (!data || data.type !== 'gratisgis:ago-oauth-token') return;
      if (!data.token) {
        setError('OAuth popup returned no token.');
        setBusy(null);
        return;
      }
      // Reconstruct the sharingRestBase the popup used. We saved
      // it in sessionStorage alongside the state when we opened
      // the popup so the opener never has to re-derive it.
      const sharingRestBase =
        window.sessionStorage.getItem(SHARING_BASE_STORAGE_KEY) ?? '';
      const orgUrlAtAuth =
        window.sessionStorage.getItem(ORG_URL_STORAGE_KEY) ?? '';
      const expiresIn = Number(data.expiresIn) || 3600;
      const receivedAt = Number(data.receivedAt) || Date.now();
      setSession({
        token: data.token,
        sharingRestBase,
        orgUrl: orgUrlAtAuth,
        expiresAtMs: receivedAt + expiresIn * 1000,
      });
      setBusy(null);
      setError(null);
      // Clean up the popup if it didn't close itself.
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
      popupRef.current = null;
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  async function signIn() {
    if (!oauthConfig.configured) return;
    if (!orgUrl.trim()) {
      setError('Enter your ArcGIS Online org URL first.');
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
        body: JSON.stringify({ orgUrl: orgUrl.trim(), redirectUri }),
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
      };
      // Stash the state + sharingRestBase so the callback page
      // can verify and the opener can use it without a second
      // server round-trip.
      window.sessionStorage.setItem(STATE_STORAGE_KEY, data.state);
      window.sessionStorage.setItem(
        SHARING_BASE_STORAGE_KEY,
        data.sharingRestBase,
      );
      window.sessionStorage.setItem(ORG_URL_STORAGE_KEY, orgUrl.trim());

      // Open the popup at a fixed size. width/height are AGO-
      // recommended; the sign-in form needs ~520x680 to fit
      // without scrollbars on a default desktop zoom.
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
      // Detect popup-close-without-token (user clicked X / cancelled).
      const closeWatcher = window.setInterval(() => {
        if (popup.closed) {
          window.clearInterval(closeWatcher);
          // Only flip back to idle if we never received the
          // token-postMessage (the success path clears
          // popupRef before close).
          if (popupRef.current === popup) {
            setBusy(null);
            setError('Sign-in window was closed before completing.');
            popupRef.current = null;
          }
        }
      }, 500);
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : String(e));
    }
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

  if (!oauthConfig.configured) {
    return (
      <section className="rounded-lg border border-warning/30 bg-warning/5 p-5 text-sm text-warning">
        <p className="font-medium">OAuth is not configured on this portal.</p>
        <p className="mt-2 text-xs">
          {oauthConfig.reason ??
            'AGO_OAUTH_CLIENT_ID env var is not set on this portal.'}
        </p>
      </section>
    );
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
          <SignInPanel
            orgUrl={orgUrl}
            onChangeOrgUrl={setOrgUrl}
            onSignIn={signIn}
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

function SignInPanel({
  orgUrl,
  onChangeOrgUrl,
  onSignIn,
  busy,
}: {
  orgUrl: string;
  onChangeOrgUrl: (v: string) => void;
  onSignIn: () => void;
  busy: 'auth' | 'preview' | 'run' | null;
}) {
  return (
    <>
      <h2 className="text-base font-semibold">Sign in to ArcGIS Online</h2>
      <p className="mb-4 mt-1 text-xs text-muted">
        Enter your org URL (e.g. <code>palavido.maps.arcgis.com</code> or{' '}
        <code>https://www.arcgis.com</code>). The sign-in happens in a popup;
        the token never leaves this portal.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-muted">ArcGIS Online org URL</span>
        <input
          type="text"
          autoFocus
          className="rounded border border-border bg-surface-0 px-2 py-1.5 text-sm"
          value={orgUrl}
          onChange={(e) => onChangeOrgUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSignIn();
          }}
          placeholder="palavido.maps.arcgis.com"
        />
      </label>
      <div className="mt-4">
        <button
          type="button"
          disabled={!orgUrl.trim() || busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          onClick={onSignIn}
        >
          {busy === 'auth' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <LogIn className="h-4 w-4" />
          )}
          Sign in to ArcGIS Online
        </button>
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
          <h2 className="text-base font-semibold">Connected to ArcGIS Online</h2>
          <p className="mt-1 text-xs text-muted">
            <span className="font-mono">{session.orgUrl}</span> &middot; token
            expires in ~{minutesLeft} min
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

// Unused-import silencer for the CloudDownload icon import that
// the legacy version kept. Keeps the lint pass clean if a future
// refactor reaches for it.
void CloudDownload;
