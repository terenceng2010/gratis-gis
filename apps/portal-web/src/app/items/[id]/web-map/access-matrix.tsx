'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, Loader2, Search, Users, X } from 'lucide-react';
import type {
  WebMapLayer,
  WebMapLayerAccess,
  WebMapLayerAccessEntry,
} from '@gratis-gis/shared-types';
import { DEFAULT_LAYER_ACCESS } from '@gratis-gis/shared-types';

/**
 * Principal surfaced in the matrix columns. Resolved by the parent
 * from whatever share records are on the item, with user/group
 * names looked up for display. Unresolved names fall back to the
 * short id so the matrix can still render during a lookup.
 */
export interface MatrixPrincipal {
  type: 'user' | 'group';
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  layers: WebMapLayer[];
  principals: MatrixPrincipal[];
  onClose: () => void;
  /** Patch a single layer's `access` field; parent merges into its state. */
  onPatchAccess: (layerId: string, next: WebMapLayerAccess) => void;
}

/**
 * Per-layer access matrix modal for a web map.
 *
 * Model: rows are layers, columns are the principals the webmap is
 * already shared with. Each cell is a compact badge that opens a
 * popover with View / Query / Edit checkboxes — this is the
 * compact-cell-with-popover pattern from the sharing design doc,
 * 1/3 the width of a flat 3-column-per-principal matrix so it fits
 * without horizontal scroll for the common case (≤10 principals).
 *
 * Cascading happens only on save: toggling View off in the popover
 * doesn't immediately clear Query/Edit values, so users can flip
 * View around without losing their permission intent. The effective
 * access on render does cap (if View=false you see an empty badge
 * even when Query/Edit are true in state).
 */
export function AccessMatrix({
  open,
  layers,
  principals,
  onClose,
  onPatchAccess,
}: Props) {
  const [filter, setFilter] = useState('');
  const [activePopover, setActivePopover] = useState<{
    layerId: string;
    principalKey: string;
  } | null>(null);

  // Reset local UI state when the modal reopens.
  useEffect(() => {
    if (!open) setActivePopover(null);
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return layers;
    return layers.filter((l) => l.title.toLowerCase().includes(q));
  }, [layers, filter]);

  if (!open) return null;

  const principalKey = (p: MatrixPrincipal) => `${p.type}:${p.id}`;

  function entryFor(
    layer: WebMapLayer,
    p: MatrixPrincipal,
  ): WebMapLayerAccessEntry {
    const acc = layer.access ?? DEFAULT_LAYER_ACCESS;
    const found = acc.entries.find(
      (e) => e.principalType === p.type && e.principalId === p.id,
    );
    if (found) return found;
    // Default: if policy is 'inherit', everyone shared on the webmap
    // gets view-and-query by default; 'custom' defaults to hidden.
    if (acc.policy === 'custom') {
      return {
        principalType: p.type,
        principalId: p.id,
        view: false,
        query: false,
        edit: false,
      };
    }
    return {
      principalType: p.type,
      principalId: p.id,
      view: true,
      query: true,
      edit: false,
    };
  }

  function writeEntry(
    layer: WebMapLayer,
    p: MatrixPrincipal,
    patch: Partial<WebMapLayerAccessEntry>,
  ) {
    const acc = layer.access ?? DEFAULT_LAYER_ACCESS;
    const next: WebMapLayerAccess = {
      // First adjustment flips the layer to 'custom' so the server
      // knows the matrix is authoritative from here on.
      policy: 'custom',
      entries: [...acc.entries],
    };
    const idx = next.entries.findIndex(
      (e) => e.principalType === p.type && e.principalId === p.id,
    );
    const current = entryFor(layer, p);
    const merged: WebMapLayerAccessEntry = { ...current, ...patch };
    if (idx >= 0) next.entries[idx] = merged;
    else next.entries.push(merged);
    onPatchAccess(layer.id, next);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Layer access matrix"
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-base font-semibold">Layer access</h2>
            <p className="text-xs text-muted">
              Refine what each shared user or group can see on this map. The
              matrix can only narrow access — it can&apos;t grant access the
              underlying layer items don&apos;t already allow.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-3 border-b border-border bg-surface-1 px-4 py-3">
          <label className="relative min-w-0 flex-1 max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter layers..."
              className="h-8 w-full rounded-md border border-border bg-surface-1 pl-8 pr-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </label>
          <div className="text-xs text-muted">
            {filtered.length} layer{filtered.length === 1 ? '' : 's'} ×{' '}
            {principals.length} principal
            {principals.length === 1 ? '' : 's'}
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {principals.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted">
              <Users className="h-6 w-6" />
              <p>Share the map with at least one user or group first.</p>
              <p className="text-xs">
                The matrix only shows principals that already have
                access to the webmap itself.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted">
              No layers match the filter.
            </div>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 bg-surface-1">
                <tr>
                  <th className="sticky left-0 z-10 border-b border-r border-border bg-surface-1 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-muted">
                    Layer
                  </th>
                  {principals.map((p) => (
                    <th
                      key={principalKey(p)}
                      className="border-b border-border px-2 py-2 text-center font-medium"
                    >
                      <div className="flex flex-col items-center gap-0.5">
                        <span className="text-xs text-ink-0">{p.name}</span>
                        <span className="text-[10px] text-muted">
                          {p.type}
                        </span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((layer) => (
                  <tr key={layer.id} className="hover:bg-surface-2/60">
                    <td className="sticky left-0 z-[1] border-r border-b border-border bg-surface-1 px-3 py-2 text-left">
                      <div className="truncate text-sm font-medium text-ink-0">
                        {layer.title}
                      </div>
                      <div className="text-[11px] text-muted">
                        {layer.access?.policy ?? 'inherit'}
                      </div>
                    </td>
                    {principals.map((p) => {
                      const key = principalKey(p);
                      const entry = entryFor(layer, p);
                      const isOpen =
                        activePopover?.layerId === layer.id &&
                        activePopover.principalKey === key;
                      return (
                        <td
                          key={key}
                          className="relative border-b border-border px-2 py-1 text-center"
                        >
                          <AccessBadge
                            entry={entry}
                            onClick={() =>
                              setActivePopover(
                                isOpen
                                  ? null
                                  : { layerId: layer.id, principalKey: key },
                              )
                            }
                          />
                          {isOpen ? (
                            <AccessPopover
                              entry={entry}
                              onChange={(patch) =>
                                writeEntry(layer, p, patch)
                              }
                              onClose={() => setActivePopover(null)}
                            />
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border bg-surface-1 px-4 py-3 text-[11px] text-muted">
          <span>
            Changes flow into the map&apos;s layers immediately and are
            persisted on the next Save map.
          </span>
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-border bg-surface-1 px-3 text-xs text-ink-1 hover:bg-surface-2"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact one-cell summary of an access entry. "—" means the layer
 * is hidden for this principal (View off, which caps Query/Edit at
 * render time); "V", "V+Q", "V+Q+E" describe the effective set.
 */
function AccessBadge({
  entry,
  onClick,
}: {
  entry: WebMapLayerAccessEntry;
  onClick: () => void;
}) {
  const effective = {
    view: entry.view,
    query: entry.view && entry.query,
    edit: entry.view && entry.query && entry.edit,
  };
  const label = !effective.view
    ? '—'
    : effective.edit
      ? 'V+Q+E'
      : effective.query
        ? 'V+Q'
        : 'V';
  const tone = !effective.view
    ? 'bg-surface-2 text-muted border-border'
    : effective.edit
      ? 'bg-accent text-accent-foreground border-accent'
      : effective.query
        ? 'bg-accent/10 text-accent border-accent/40'
        : 'bg-surface-1 text-ink-0 border-border';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-7 min-w-[3.25rem] items-center justify-center gap-1 rounded-md border px-2 text-[11px] font-medium tabular-nums transition-colors hover:brightness-95 ${tone}`}
    >
      <Eye className="h-3 w-3 opacity-70" />
      {label}
    </button>
  );
}

/**
 * Popover exposing the raw View/Query/Edit toggles. Closes on outside
 * click or Esc. Keeps its own local state for snappy feedback, then
 * bubbles each toggle up through onChange.
 */
function AccessPopover({
  entry,
  onChange,
  onClose,
}: {
  entry: WebMapLayerAccessEntry;
  onChange: (patch: Partial<WebMapLayerAccessEntry>) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      className="absolute left-1/2 top-full z-20 mt-1 w-48 -translate-x-1/2 rounded-md border border-border bg-surface-1 p-2 text-left shadow-raised"
    >
      <PopoverRow
        label="View"
        desc="See the layer on the map"
        checked={entry.view}
        onChange={(v) => onChange({ view: v })}
      />
      <PopoverRow
        label="Query"
        desc="Popups, attribute table, search"
        checked={entry.query}
        disabled={!entry.view}
        onChange={(v) => onChange({ query: v })}
      />
      <PopoverRow
        label="Edit"
        desc="Modify features (future)"
        checked={entry.edit}
        disabled={!entry.view || !entry.query}
        onChange={(v) => onChange({ edit: v })}
      />
    </div>
  );
}

function PopoverRow({
  label,
  desc,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 ${
        disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-surface-2'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/30"
      />
      <div className="flex-1">
        <div className="text-xs font-medium text-ink-0">{label}</div>
        <div className="text-[10px] text-muted">{desc}</div>
      </div>
    </label>
  );
}

/**
 * Helper the map-editor uses to resolve shares → named principals.
 * Returns an unresolved short id until the name lookup completes so
 * the matrix can still render during fetch. Exposed here so the
 * editor and any future sharing panel view share the same rules.
 */
export function unresolvedPrincipal(
  principalType: 'user' | 'group',
  principalId: string,
): MatrixPrincipal {
  return {
    type: principalType,
    id: principalId,
    name: `${principalType}/${principalId.slice(0, 8)}`,
  };
}

export { Loader2 };
