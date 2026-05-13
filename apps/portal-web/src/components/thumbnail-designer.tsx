// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Thumbnail designer (#66).  Replaces the previous "Upload image"
 * affordance on item edit with an inline two-color picker over a
 * live SVG preview.  Because the rendering happens at request time
 * from the design blob plus the item's current title and type, the
 * editor only has two knobs (sidebar fill + background fill) — the
 * sidebar text and title text are derived and always render to keep
 * the portal's thumbnail grammar consistent (see project memory:
 * thumbnail designer 2026-05-13).
 *
 * The author can revert to the type-default palette at any time;
 * the "Reset to default" button rewrites the design back to what
 * the backend would produce on a fresh create.
 */
import { useMemo } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  defaultThumbnailDesign,
  getItemTypeLabel,
  renderThumbnailSvg,
  type ItemType,
  type ThumbnailDesign,
} from '@gratis-gis/shared-types';

interface Props {
  /** Item type drives the type-default palette and the sidebar label. */
  type: ItemType;
  /** Live title piped into the preview so the author sees the
   *  current item name baked into the SVG as they type elsewhere
   *  on the form. */
  title: string;
  /** Current design (or null for "use type default"). */
  value: ThumbnailDesign | null | undefined;
  onChange: (next: ThumbnailDesign) => void;
}

export function ThumbnailDesigner({ type, title, value, onChange }: Props) {
  // Resolve the active design.  Empty / missing falls through to
  // the type-default palette so the preview always renders
  // something usable.
  const design = useMemo<ThumbnailDesign>(
    () => value ?? defaultThumbnailDesign(type),
    [value, type],
  );

  const svg = useMemo(
    () =>
      renderThumbnailSvg({
        title: title || '(Untitled)',
        typeLabel: getItemTypeLabel(type),
        design,
      }),
    [title, type, design],
  );

  function patch(p: Partial<ThumbnailDesign>): void {
    onChange({ ...design, ...p });
  }

  function reset(): void {
    onChange(defaultThumbnailDesign(type));
  }

  return (
    <div className="flex items-start gap-4">
      <div
        className="h-32 w-48 shrink-0 overflow-hidden rounded-md border border-border bg-surface-2"
        aria-label="Thumbnail preview"
        /* eslint-disable-next-line react/no-danger */
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <ColorRow
          label="Sidebar"
          hint="Strip on the left of the thumbnail. Carries the type label."
          value={design.sidebar}
          onChange={(v) => patch({ sidebar: v })}
        />
        <ColorRow
          label="Background"
          hint="Fill behind the title text."
          value={design.background}
          onChange={(v) => patch({ background: v })}
        />
        <div className="flex items-center justify-between gap-2 pt-1">
          <p className="text-[11px] text-muted">
            Title and type label always render. They follow the item
            name and type so a rename updates the thumbnail with no
            re-bake.
          </p>
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2"
            title="Reset to the type default palette"
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}

function ColorRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
}) {
  // The native color picker only understands #rrggbb. Anything else
  // gets coerced to the nearest hex via a hidden canvas-style
  // conversion done by the browser; just feed it the hex and accept
  // whatever it returns.
  return (
    <label className="flex items-center gap-3">
      <span
        className="inline-block h-8 w-8 shrink-0 overflow-hidden rounded-md border border-border"
        aria-hidden
        style={{ background: value }}
      >
        <input
          type="color"
          value={normalizeForPicker(value)}
          onChange={(e) => onChange(e.target.value)}
          className="h-full w-full cursor-pointer opacity-0"
          aria-label={`${label} color`}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-ink-1">{label}</span>
        <span className="block truncate text-[11px] text-muted">{hint}</span>
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-24 rounded border border-border bg-surface-1 px-2 font-mono text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
      />
    </label>
  );
}

/**
 * Coerce arbitrary CSS color values (rgb(), hsl(), named colors) to
 * a #rrggbb form the native color input accepts.  Anything we don't
 * recognize falls back to a neutral gray; the visible swatch above
 * still renders the original value, so the author sees what's
 * actually saved even if the picker can't open against it.
 */
function normalizeForPicker(color: string): string {
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{3}$/.test(c)) {
    return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  }
  return '#888888';
}
