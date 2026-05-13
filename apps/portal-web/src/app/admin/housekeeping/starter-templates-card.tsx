// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Housekeeping "Starter app templates" card.
 *
 * The four starter app_template items (Sidebar Explorer, Showcase
 * Map, Compact Drawer, Blank Canvas) are seeded into every org on
 * first sign-in.  After that, admins are free to edit / delete /
 * replace them like any other item.  This card surfaces the
 * "factory reset" path: it lists each starter with a present /
 * missing badge and lets the admin click a single button to bring
 * back whichever ones are missing.
 *
 * Force-restore (alongside an existing copy with a date-suffixed
 * title) is exposed via a checkbox so a power user can grab a
 * fresh reference without losing their customizations.
 */
import { useState } from 'react';
import Link from 'next/link';
import { Wand2 } from 'lucide-react';

interface StarterStatus {
  kind: string;
  label: string;
  description: string;
  itemId: string | null;
}

interface Props {
  initial: StarterStatus[];
}

export function StarterTemplatesCard({ initial }: Props) {
  const [starters, setStarters] = useState<StarterStatus[]>(initial);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState<'all' | string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshStatus(): Promise<void> {
    try {
      const res = await fetch(
        '/api/portal/admin/app-templates/starter-status',
        { cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { starters: StarterStatus[] };
      setStarters(body.starters);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh.');
    }
  }

  async function restore(kinds: string[] | null): Promise<void> {
    setError(null);
    setBusy(kinds === null ? 'all' : (kinds[0] ?? null));
    try {
      const res = await fetch(
        '/api/portal/admin/app-templates/restore-starters',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(kinds !== null ? { kinds } : {}),
            force,
          }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed.');
    } finally {
      setBusy(null);
    }
  }

  const missingCount = starters.filter((s) => s.itemId === null).length;

  return (
    <section className="rounded-lg border border-border bg-surface-1 p-5 shadow-card">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-amber-700/10 text-amber-700">
          <Wand2 className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-ink-0">
            Starter app templates
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            Built-in templates seeded into your org. Edit them like
            any other item, or use the restore button if any have
            been deleted.
          </p>
        </div>
      </header>

      {error ? (
        <div className="mb-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      ) : null}

      <ul className="mb-4 divide-y divide-border rounded-md border border-border">
        {starters.map((s) => (
          <li
            key={s.kind}
            className="flex items-center gap-3 px-3 py-2 text-sm"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-ink-0">
                {s.label}
              </span>
              <span className="block truncate text-xs text-muted">
                {s.description}
              </span>
            </span>
            {s.itemId ? (
              <Link
                href={`/items/${s.itemId}`}
                className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success hover:underline"
              >
                Present
              </Link>
            ) : (
              <span className="rounded-full bg-warn/10 px-2 py-0.5 text-xs font-medium text-warn">
                Missing
              </span>
            )}
            <button
              type="button"
              disabled={busy !== null || (s.itemId !== null && !force)}
              onClick={() => restore([s.kind])}
              className="rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-ink-1 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === s.kind ? 'Restoring...' : 'Restore'}
            </button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-ink-1">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            disabled={busy !== null}
          />
          Force-restore even when present (creates a date-suffixed
          copy alongside existing customizations)
        </label>
        <button
          type="button"
          onClick={() => restore(null)}
          disabled={busy !== null || (!force && missingCount === 0)}
          className="ml-auto inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy === 'all'
            ? 'Restoring...'
            : force
              ? 'Restore all (fresh copies)'
              : `Restore missing (${missingCount})`}
        </button>
      </div>
    </section>
  );
}
