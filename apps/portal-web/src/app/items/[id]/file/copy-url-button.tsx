// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * Copy-URL pill for the File item detail page. Click to write the
 * file's public storage URL to the clipboard; the button flips to a
 * "Copied" affirmation for ~1.5s so the user gets feedback without
 * a toast queue.
 *
 * Lifted out of FileDetail as a client component because the parent
 * is a server component and clipboard access is browser-only.
 *
 * Why this exists at all: authors building Custom Web Apps need to
 * embed images / logos / supporting documents stored as File items.
 * The previous path was "open the file item in a new tab, copy the
 * address bar OR right-click on the preview image and Copy Image
 * Address." That's discoverable only after you've done it once. A
 * Copy URL button on the detail page makes the workflow obvious and
 * stays consistent with the eventual File-item picker in widget
 * config UIs.
 */
export function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers / restrictive clipboard permissions: fall
      // back to selecting the URL via a temporary input so the user
      // can copy manually. Doesn't toast; the visible URL stays
      // selected, which is the cue.
      const tmp = document.createElement('input');
      tmp.value = url;
      document.body.appendChild(tmp);
      tmp.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } catch {
        // give up silently; the user can still right-click +
        // copy from the visible preview link
      }
      document.body.removeChild(tmp);
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-live="polite"
      title="Copy public URL"
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 shadow-card transition-colors hover:bg-surface-2"
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-success" />
          Copied
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" />
          Copy URL
        </>
      )}
    </button>
  );
}
