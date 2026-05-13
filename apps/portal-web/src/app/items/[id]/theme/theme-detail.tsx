// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Theme item detail view (#22 v1).  Renders the swatch + a read-
 * only token grid so an admin can review what's in a seeded
 * starter or a user-saved theme.  Full token editor (color
 * pickers per token + live preview against a sample app shell)
 * is a planned follow-up; the v1 surface lets a user verify the
 * theme exists, copy / share / delete it like any other item,
 * and pick it from the Custom Web App designer.
 */
import { Palette } from 'lucide-react';

interface Props {
  itemId: string;
  blueprint: {
    version?: number;
    swatch?: string;
    tokens?: Record<string, string>;
  };
  seedKind: string | null;
}

/**
 * Token groupings so the read-only table renders in a meaningful
 * order (surface ladder, then ink, then accent, then status, then
 * geometry).  Unknown tokens fall into "Other".
 */
const TOKEN_GROUPS: Array<{ label: string; prefixes: string[] }> = [
  { label: 'Surfaces', prefixes: ['--app-surface', '--app-header'] },
  { label: 'Ink + borders', prefixes: ['--app-ink', '--app-muted', '--app-border'] },
  { label: 'Accent', prefixes: ['--app-accent'] },
  { label: 'Status', prefixes: ['--app-success', '--app-warn', '--app-danger', '--app-info'] },
  { label: 'Geometry', prefixes: ['--app-radius', '--app-shadow', '--app-density'] },
];

export function AppThemeDetail({ itemId, blueprint, seedKind }: Props) {
  void itemId;
  const tokens = blueprint.tokens ?? {};
  const grouped = groupTokens(tokens);
  const swatch = blueprint.swatch ?? 'hsl(210 40% 96%)';

  return (
    <section className="mb-6 rounded-lg border border-border bg-surface-1 p-5 shadow-card">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-pink-500/10 text-pink-600">
          <Palette className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted">Theme</p>
          <h2 className="text-base font-semibold text-ink-0">
            Reusable color palette
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            Pick this theme in any Custom Web App&apos;s right rail
            to apply its tokens at runtime.
          </p>
        </div>
        <span
          aria-hidden
          className="h-9 w-9 shrink-0 rounded-md border border-border"
          style={{ background: swatch }}
          title={swatch}
        />
      </header>

      <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
        <div>
          <dt className="text-muted">Swatch</dt>
          <dd className="font-mono text-ink-0">{swatch}</dd>
        </div>
        <div>
          <dt className="text-muted">Origin</dt>
          <dd className="font-medium text-ink-0">
            {seedKind ? `built-in: ${seedKind}` : 'user-saved'}
          </dd>
        </div>
      </dl>

      <div className="space-y-3">
        {grouped.map((g) =>
          g.entries.length === 0 ? null : (
            <div key={g.label}>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                {g.label}
              </p>
              <ul className="divide-y divide-border rounded-md border border-border">
                {g.entries.map(([k, v]) => (
                  <li
                    key={k}
                    className="flex items-center gap-3 px-3 py-1.5 text-xs"
                  >
                    {/* Show a small color preview if the token
                        value parses as a CSS color (HSL/RGB/hex).
                        Falls back to a dash for non-color values
                        (radius lengths, shadows, density). */}
                    <span
                      aria-hidden
                      className="h-3.5 w-3.5 shrink-0 rounded-sm border border-border"
                      style={{
                        background: tokenLooksLikeColor(v)
                          ? `hsl(${v})`
                          : 'transparent',
                      }}
                    />
                    <span className="w-60 truncate font-mono text-ink-0">
                      {k}
                    </span>
                    <span className="truncate font-mono text-muted">
                      {v}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ),
        )}
      </div>

      <p className="mt-4 text-[11px] text-muted">
        Token editor with live preview is a planned follow-up.
        For now, edit a theme by reading the raw JSON in this
        item&apos;s data field via the API, or save a fresh theme
        from a Custom Web App you&apos;ve customized.
      </p>
    </section>
  );
}

function groupTokens(
  tokens: Record<string, string>,
): Array<{ label: string; entries: Array<[string, string]> }> {
  const out = TOKEN_GROUPS.map((g) => ({
    label: g.label,
    entries: [] as Array<[string, string]>,
  }));
  const other: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(tokens)) {
    const idx = TOKEN_GROUPS.findIndex((g) =>
      g.prefixes.some((p) => k.startsWith(p)),
    );
    if (idx >= 0) {
      out[idx]!.entries.push([k, v]);
    } else {
      other.push([k, v]);
    }
  }
  if (other.length > 0) {
    out.push({ label: 'Other', entries: other });
  }
  return out;
}

/**
 * Heuristic: is this token value a bare HSL triplet?  We render
 * a small color swatch beside it if so; otherwise the cell shows
 * just the value (lengths, shadows, density numbers).
 */
function tokenLooksLikeColor(v: string): boolean {
  return /^\d/.test(v.trim()) && (v.includes('%') || v.includes(','));
}
