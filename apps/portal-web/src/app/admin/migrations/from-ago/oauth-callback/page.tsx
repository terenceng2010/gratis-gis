// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import { STATE_STORAGE_KEY, TOKEN_CHANNEL_NAME } from '../oauth-storage-keys';

/**
 * AGO OAuth callback page. Runs inside a small popup window the
 * /admin/migrations/from-ago page opened. AGO's implicit-grant
 * flow returns the access token in the URL fragment (after #),
 * not the query string -- the server-side framework never sees
 * it. This client-only page reads it, validates the state token
 * matches the one the opener tucked into the popup's
 * sessionStorage, posts the token to a BroadcastChannel the
 * opener is subscribed to, and closes itself.
 *
 * Why BroadcastChannel instead of window.opener.postMessage:
 *  - The popup navigates gratisgis -> AGO (cross-origin) -> back
 *    to gratisgis. Browsers (especially Edge / Chrome with strict
 *    COOP) sever window.opener on that hop, leaving the popup
 *    with no reference to talk back to the opener even on a
 *    successful sign-in.
 *  - BroadcastChannel is same-origin-only (security boundary
 *    intact), works regardless of opener relationships, and is
 *    available in every modern browser.
 *
 * Why a separate page instead of inline state on the importer:
 *  - The popup model isolates the auth round trip from the
 *    importer dialog's React state.
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
      // Hand the token to the opener via BroadcastChannel. The
      // opener subscribed to TOKEN_CHANNEL_NAME before opening
      // this popup; the channel is same-origin so cross-origin
      // navigation doesn't sever it the way window.opener does.
      const payload = {
        type: 'gratisgis:ago-oauth-token' as const,
        token,
        state,
        expiresIn,
        // Echoing receivedAt lets the opener expire the token from
        // its in-memory store at the right wall-clock moment
        // instead of trusting expires_in relative to popup-load.
        receivedAt: Date.now(),
      };
      let delivered = false;
      try {
        const ch = new BroadcastChannel(TOKEN_CHANNEL_NAME);
        ch.postMessage(payload);
        ch.close();
        delivered = true;
      } catch {
        // BroadcastChannel unsupported (very old browser); fall
        // through to the window.opener fallback below.
      }
      // Fallback: try window.opener.postMessage too, in case the
      // browser DID preserve the opener relationship. Belt and
      // suspenders, since either channel reaching the opener
      // succeeds.
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, window.location.origin);
          delivered = true;
        }
      } catch {
        /* opener gone; BroadcastChannel was our path */
      }
      if (!delivered) {
        finishFail(
          'Could not deliver the access token back to the importer ' +
            'page. Close this window and try sign-in again from the ' +
            'importer page in the original tab.',
        );
        return;
      }
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

