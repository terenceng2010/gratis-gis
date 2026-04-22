'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Filter as FilterIcon,
  Focus,
  Search,
  Table,
  X,
} from 'lucide-react';
import type {
  WebMapLayer,
  WebMapLayerFilter,
} from '@gratis-gis/shared-types';
import type { LayerMetadata } from './layer-metadata';

interface Props {
  open: boolean;
  layers: WebMapLayer[];
  /**
   * Cached feature collections keyed by layer id. The parent fetches
   * these lazily when the table opens so we don't refetch per render.
   */
  featuresByLayer: Record<string, GeoJSON.FeatureCollection | null>;
  metadata: Record<string, LayerMetadata>;
  canEdit: boolean;
  onClose: () => void;
  /** Fly to a bbox in the map canvas. */
  onZoomTo: (bbox: [number, number, number, number]) => void;
  /** Replace the layer filter (used by "convert selection to filter"). */
  onPatchLayer: (layerId: string, patch: Partial<WebMapLayer>) => void;
}

type SortDir = 'asc' | 'desc';

/**
 * Bottom-overlay attribute table. One layer at a time; the top-row
 * picker switches the focused layer. Rows are the layer's features;
 * columns are the layer's attribute fields.
 *
 * Interactions:
 *   - Click a column header to sort (click again to flip direction).
 *   - Click a row to toggle its selection; shift-click for a range.
 *   - Toolbar: Zoom to selection, text Query, "Use selection as filter".
 *   - Edit is gated on canEdit + a source that supports writes. For
 *     now, feature-service sources only accept replace-all updates, so
 *     row-level edit is stubbed with a friendly message.
 */
export function AttributeTable({
  open,
  layers,
  featuresByLayer,
  metadata,
  canEdit,
  onClose,
  onZoomTo,
  onPatchLayer,
}: Props) {
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [lastPicked, setLastPicked] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [query, setQuery] = useState('');

  // Default to the top visible layer whenever the list changes.
  useEffect(() => {
    if (!open) return;
    if (activeLayerId && layers.some((l) => l.id === activeLayerId)) return;
    const first = layers.find((l) => l.visible) ?? layers[0] ?? null;
    setActiveLayerId(first?.id ?? null);
    setSelection(new Set());
    setLastPicked(null);
    setSortBy(null);
    setQuery('');
  }, [open, layers, activeLayerId]);

  const activeLayer = layers.find((l) => l.id === activeLayerId) ?? null;
  const activeFields =
    activeLayer && metadata[activeLayer.id]?.fields.length
      ? metadata[activeLayer.id]!.fields
      : [];
  const activeFeatures =
    (activeLayer ? featuresByLayer[activeLayer.id] : null)?.features ?? [];

  // Apply query + sort. Indexes into `activeFeatures`, not flattened,
  // so selection indices always line up with the source array.
  const visibleIndexes = useMemo(() => {
    const q = query.trim().toLowerCase();
    let idxs = activeFeatures.map((_, i) => i);
    if (q.length > 0) {
      idxs = idxs.filter((i) => {
        const props = (activeFeatures[i]?.properties ?? {}) as Record<
          string,
          unknown
        >;
        for (const v of Object.values(props)) {
          if (v === null || v === undefined) continue;
          if (String(v).toLowerCase().includes(q)) return true;
        }
        return false;
      });
    }
    if (sortBy) {
      idxs.sort((a, b) => {
        const av = ((activeFeatures[a]?.properties ?? {}) as Record<string, unknown>)[
          sortBy
        ];
        const bv = ((activeFeatures[b]?.properties ?? {}) as Record<string, unknown>)[
          sortBy
        ];
        const cmp = compareValues(av, bv);
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }
    return idxs;
  }, [activeFeatures, query, sortBy, sortDir]);

  function onHeaderClick(field: string) {
    if (sortBy === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortDir('asc');
    }
  }

  function onRowClick(displayIdx: number, shift: boolean) {
    const idx = visibleIndexes[displayIdx];
    if (idx === undefined) return;
    setSelection((prev) => {
      const next = new Set(prev);
      if (shift && lastPicked !== null) {
        const a = Math.min(displayIdx, lastPicked);
        const b = Math.max(displayIdx, lastPicked);
        for (let i = a; i <= b; i += 1) {
          const ix = visibleIndexes[i];
          if (ix !== undefined) next.add(ix);
        }
      } else {
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
      }
      return next;
    });
    setLastPicked(displayIdx);
  }

  function zoomToSelection() {
    if (selection.size === 0) return;
    const features = [...selection]
      .map((i) => activeFeatures[i])
      .filter((f): f is GeoJSON.Feature => Boolean(f && f.geometry));
    if (features.length === 0) return;
    const bbox = bboxOfFeatures(features);
    if (bbox) onZoomTo(bbox);
  }

  function selectionToFilter() {
    if (!activeLayer || selection.size === 0) return;
    // Strategy: if the features carry a stable id field, convert to a
    // single `in` clause. Otherwise fall back to a boolean-OR of per-
    // feature primary-key guesses. If no usable id field is
    // discoverable, we bail with a visible error rather than silently
    // filtering nothing.
    const idField = pickIdField(activeFields, activeFeatures, selection);
    if (!idField) return;
    const values = [...selection]
      .map((i) => {
        const v = (activeFeatures[i]?.properties ?? {}) as Record<string, unknown>;
        return v[idField];
      })
      .filter((v) => v !== null && v !== undefined)
      .map((v) => String(v));
    if (values.length === 0) return;
    // A single multi-clause filter with OR'd == clauses keeps it
    // compatible with the existing filter editor.
    const filter: WebMapLayerFilter = {
      combinator: 'any',
      clauses: values.map((v) => ({ field: idField, op: '==' as const, value: v })),
    };
    onPatchLayer(activeLayer.id, { filter });
  }

  if (!open) return null;

  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 flex h-[40%] min-h-[240px] flex-col border-t border-border bg-surface-1 shadow-overlay">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
          <Table className="h-3.5 w-3.5" />
          Attribute table
        </h3>
        {layers.length > 0 ? (
          <select
            value={activeLayerId ?? ''}
            onChange={(e) => {
              setActiveLayerId(e.target.value);
              setSelection(new Set());
              setQuery('');
              setSortBy(null);
            }}
            className="h-7 min-w-0 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            {layers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
        ) : null}
        <div className="ml-2 flex flex-1 items-center gap-2">
          <label className="relative block min-w-0 max-w-xs flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Query any field..."
              className="h-7 w-full rounded border border-border bg-surface-1 pl-7 pr-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            />
          </label>
          <span className="text-[11px] text-muted">
            {visibleIndexes.length.toLocaleString()} rows
            {selection.size > 0 ? ` · ${selection.size} selected` : ''}
          </span>
        </div>
        <button
          type="button"
          onClick={zoomToSelection}
          disabled={selection.size === 0}
          className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          title="Zoom to selected features"
        >
          <Focus className="h-3.5 w-3.5" />
          Zoom to
        </button>
        <button
          type="button"
          onClick={selectionToFilter}
          disabled={selection.size === 0 || !activeLayer}
          className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          title="Filter the layer to only the selected features"
        >
          <FilterIcon className="h-3.5 w-3.5" />
          Use as filter
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {!activeLayer ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          No layer selected.
        </div>
      ) : activeFeatures.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          {metadata[activeLayer.id]?.loading
            ? 'Loading features...'
            : 'No features to show.'}
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="min-w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-surface-2">
              <tr>
                <th className="w-8 border-b border-border px-2 py-1.5" />
                {activeFields.map((f) => (
                  <th
                    key={f}
                    onClick={() => onHeaderClick(f)}
                    className="cursor-pointer border-b border-border px-3 py-1.5 text-left font-medium text-ink-1 hover:bg-surface-1"
                  >
                    <span className="inline-flex items-center gap-1">
                      {f}
                      {sortBy === f ? (
                        sortDir === 'asc' ? (
                          <ArrowUp className="h-3 w-3" />
                        ) : (
                          <ArrowDown className="h-3 w-3" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3 text-muted/50" />
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleIndexes.map((idx, displayIdx) => {
                const feature = activeFeatures[idx];
                if (!feature) return null;
                const props = (feature.properties ?? {}) as Record<
                  string,
                  unknown
                >;
                const selected = selection.has(idx);
                return (
                  <tr
                    key={idx}
                    onClick={(e) => onRowClick(displayIdx, e.shiftKey)}
                    className={`cursor-pointer border-b border-border ${
                      selected
                        ? 'bg-accent/10 hover:bg-accent/15'
                        : 'hover:bg-surface-2'
                    }`}
                  >
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        readOnly
                        checked={selected}
                        className="pointer-events-none h-3 w-3 rounded border-border text-accent"
                      />
                    </td>
                    {activeFields.map((field) => {
                      const v = props[field];
                      return (
                        <td
                          key={field}
                          className="whitespace-nowrap px-3 py-1 text-ink-1"
                        >
                          {formatCell(v)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canEdit ? (
        <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted">
          Row-level editing lands when feature services store data in
          PostGIS. For now, edit the dataset by replacing the whole
          FeatureCollection from the feature-service detail page.
        </div>
      ) : null}
    </div>
  );
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Bounding box across an arbitrary set of features. Walks every
 * coordinate; safe for small-to-mid datasets (the selection in the
 * attribute table). Returns null for a selection that has no valid
 * geometries.
 */
function bboxOfFeatures(
  features: GeoJSON.Feature[],
): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;

  function visit(coord: unknown) {
    if (Array.isArray(coord)) {
      if (coord.length >= 2 && typeof coord[0] === 'number' && typeof coord[1] === 'number') {
        const x = coord[0] as number;
        const y = coord[1] as number;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        seen = true;
      } else {
        for (const c of coord) visit(c);
      }
    }
  }

  for (const f of features) {
    const geom = f.geometry;
    if (!geom) continue;
    if ('coordinates' in geom) visit(geom.coordinates);
    if (geom.type === 'GeometryCollection') {
      for (const g of geom.geometries) {
        if ('coordinates' in g) visit(g.coordinates);
      }
    }
  }
  return seen ? [minX, minY, maxX, maxY] : null;
}

/**
 * Heuristic pick for a stable id field. Prefers fields literally named
 * `id`, `fid`, `objectid`, then the first field whose values are
 * unique across the selected feature subset.
 */
function pickIdField(
  fields: string[],
  features: GeoJSON.Feature[],
  selection: Set<number>,
): string | null {
  const common = ['id', 'fid', 'objectid', 'OBJECTID', 'FID', 'ID'];
  for (const c of common) {
    if (fields.includes(c)) return c;
  }
  for (const f of fields) {
    const seen = new Set<string>();
    let unique = true;
    for (const i of selection) {
      const v = ((features[i]?.properties ?? {}) as Record<string, unknown>)[f];
      if (v === null || v === undefined) {
        unique = false;
        break;
      }
      const key = String(v);
      if (seen.has(key)) {
        unique = false;
        break;
      }
      seen.add(key);
    }
    if (unique) return f;
  }
  return null;
}
