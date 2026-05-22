// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import { STATE_STORAGE_KEY } from '../oauth-storage-keys';

/**
 * AGO OAuth callback page. Runs inside a small popup window the
 * /admin/migrations/from-ago page opened. AGO's implicit-grant
 * flow returns the access token in the URL fragment (after #),
 * not the query string -- the server-side framework never sees
 * it. This client-only page reads it, validates the state token
 * matches the one the opener tucked into the popup's
 * sessionStorage, posts the token back to the opener via
 * window.opener.postMessage, and closes itself.
 *
 * Why a separate page instead of inline state on the importer:
 *  - The popup model isolates the auth round trip from the
 *    importer dialog's React state, so a stray browser-side
 *    extension that munges the URL fragment can't poison the
 *    importer page.
 *  - AGO's allowed redirect URIs are registered ahead of time;
 *    keeping the callback at a stable URL means re-registering
 *    is a one-time chore, not a per-deploy concern.
 */
export default function AgoOauthCallback() {
  const [status, setStatus] = useState<'working' | 'ok' | 'fail'>('working');
  const [reason, setReason] = useState<string>('');

  useEffect(() => {
    try {
      // AGO error path: ?error=...&error_description=... in the
      // query string, not the fragment. Check that first.
      const search = new URLSearchParams(window.location.search);
      if (search.has('error')) {
        const err = search.get('error') ?? 'unknown';
        const desc = search.get('error_description') ?? '';
        finishFail(`${err}${desc ? `: ${desc}` : ''}`);
        return;
      }
      // Success path: #access_token=...&expires_in=...&state=...
      const hash = window.location.hash.startsWith('#')
        ? window.location.hash.slice(1)
        : window.location.hash;
      const params = new URLSearchParams(hash);
      const token = params.get('access_token');
      const state = params.get('state');
      const expiresIn = Number(params.get('expires_in') ?? '0');
      if (!token || !state) {
        finishFail(
          'AGO did not return an access token. Sign-in window may have ' +
            'been cancelled or AGO rejected the request.',
        );
        return;
      }
      // Verify the CSRF state matches the one the opener stashed
      // in sessionStorage before opening this popup.
      const expectedState = window.sessionStorage.getItem(STATE_STORAGE_KEY);
      if (!expectedState || expectedState !== state) {
        finishFail(
          'OAuth state mismatch. The sign-in popup must be opened from ' +
            'the same browser tab as the importer page.',
        );
        return;
      }
      // Hand the token to the opener via postMessage and close.
      if (!window.opener || window.opener.closed) {
        finishFail(
          'Opener window is gone. Close this popup and start the ' +
            'sign-in again from the importer page.',
        );
        return;
      }
      window.opener.postMessage(
        {
          type: 'gratisgis:ago-oauth-token',
          token,
          state,
          expiresIn,
          // Echoing the receivedAt timestamp lets the opener
          // expire the token from its in-memory store at the
          // right wall-clock moment instead of trusting an
          // expires_in value relative to popup-load time.
          receivedAt: Date.now(),
        },
        window.location.origin,
      );
      // Clean up the state token so a second popup can't reuse
      // it. The opener already has the token.
      window.sessionStorage.removeItem(STATE_STORAGE_KEY);
      setStatus('ok');
      // Tiny delay so the user sees the success message before
      // the popup closes.
      window.setTimeout(() => window.close(), 600);
    } catch (e) {
      finishFail(e instanceof Error ? e.message : String(e));
    }

    function finishFail(msg: string) {
      setStatus('fail');
      setReason(msg);
    }
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-0 p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface-1 p-5 shadow-card">
        {status === 'working' && (
          <>
            <h1 className="text-base font-semibold">Finishing sign-in...</h1>
            <p className="mt-2 text-xs text-muted">
              You can close this window when it doesn&apos;t close itself.
            </p>
          </>
        )}
        {status === 'ok' && (
          <>
            <h1 className="text-base font-semibold text-success">Signed in.</h1>
            <p className="mt-2 text-xs text-muted">
              Closing this window.
            </p>
          </>
        )}
        {status === 'fail' && (
          <>
            <h1 className="text-base font-semibold text-danger">
              Sign-in failed
            </h1>
            <p className="mt-2 text-xs text-danger">{reason}</p>
            <button
              type="button"
              onClick={() => window.close()}
              className="mt-3 inline-flex items-center rounded-md border border-border bg-surface-0 px-3 py-1.5 text-xs font-medium hover:bg-surface-2"
            >
              Close window
            </button>
          </>
        )}
      </div>
    </div>
  );
}

