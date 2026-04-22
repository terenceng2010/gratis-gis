'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, List, Loader2, Save, Table } from 'lucide-react';
import type {
  BasemapKey,
  WebMapData,
  WebMapFilterOp,
  WebMapLayer,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_LAYER_INTERACTIONS,
  DEFAULT_LAYER_LABELS,
  DEFAULT_LAYER_POPUP,
  DEFAULT_LAYER_RENDERER,
  DEFAULT_LAYER_SCALE,
  DEFAULT_LAYER_SEARCH,
  DEFAULT_LAYER_STYLE,
  DEFAULT_WEB_MAP,
} from '@gratis-gis/shared-types';
import { BASEMAPS, BASEMAP_KEYS } from '@/lib/basemaps';
import { MapCanvas, type MapCanvasHandle } from './map-canvas';
import { LayerPanel } from './layer-panel';
import { AddLayerDialog } from './add-layer-dialog';
import { Legend } from './legend';
import { AttributeTable } from './attribute-table';
import { SearchBar } from './search-bar';
import { discoverLayerMetadata, type LayerMetadata } from './layer-metadata';

interface Props {
  itemId: string;
  initial: WebMapData;
  canEdit: boolean;
}

/**
 * Top-level web map surface. Owns the canonical WebMapData state; the
 * canvas renders it and the side panels edit it. Save is explicit so
 * a viewer can explore the map without side effects while an owner
 * only persists changes they actually want.
 *
 * Layout: left sidebar with layer panel, right side the map. On narrow
 * viewports the sidebar collapses into a drawer (future) — for v2 we
 * use a fixed-width sidebar and let horizontal scroll handle anything
 * below that.
 */
export function MapEditor({ itemId, initial, canEdit }: Props) {
  // Hydrate older persisted maps. Each bump in the schema lands a new
  // migrator here; the goal is that any v2.x map still opens cleanly.
  const seed = useMemo<WebMapData>(() => {
    const layers = (initial.layers ?? []).map((rawLayer) => {
      const l = rawLayer as WebMapLayer & {
        // Pre-v2.2 shape had a single-clause filter.
        filter?: unknown;
        popup?: Partial<WebMapLayer['popup']> & { fields?: unknown };
      };

      // Migrate filter: v2.1 single-clause { field, op, value }
      // → v2.2 { combinator: 'all', clauses: [...] }.
      let filter: WebMapLayer['filter'] = null;
      if (l.filter && typeof l.filter === 'object') {
        const f = l.filter as unknown as Record<string, unknown>;
        if (Array.isArray(f.clauses) && typeof f.combinator === 'string') {
          filter = f as unknown as WebMapLayer['filter'];
        } else if (typeof f.field === 'string' && typeof f.op === 'string') {
          filter = {
            combinator: 'all',
            clauses: [
              {
                field: String(f.field),
                op: f.op as WebMapFilterOp,
                value: typeof f.value === 'string' ? f.value : String(f.value ?? ''),
              },
            ],
          };
        }
      }

      // Popup: older maps might be missing `mode` / `bodyTemplate`.
      // Preserve prior picked-fields state; never discard authored content.
      const popupRaw = l.popup ?? {};
      const mode =
        popupRaw.mode === 'picked' || popupRaw.mode === 'template'
          ? popupRaw.mode
          : Array.isArray(popupRaw.fields) && popupRaw.fields.length > 0
            ? 'picked'
            : 'all';
      const popup: WebMapLayer['popup'] = {
        ...structuredClone(DEFAULT_LAYER_POPUP),
        ...popupRaw,
        mode,
        fields: Array.isArray(popupRaw.fields)
          ? (popupRaw.fields as string[])
          : [],
        bodyTemplate:
          typeof (popupRaw as { bodyTemplate?: unknown }).bodyTemplate === 'string'
            ? ((popupRaw as { bodyTemplate: string }).bodyTemplate)
            : '',
      };

      return {
        ...l,
        renderer: l.renderer ?? structuredClone(DEFAULT_LAYER_RENDERER),
        filter,
        popup,
        interactions: {
          ...structuredClone(DEFAULT_LAYER_INTERACTIONS),
          ...(l.interactions ?? {}),
        },
        labels: hydrateLabels(
          ((l as unknown) as { labels?: Record<string, unknown> }).labels ?? {},
        ),
        search: {
          ...structuredClone(DEFAULT_LAYER_SEARCH),
          ...(((l as unknown) as { search?: Partial<WebMapLayer['search']> })
            .search ?? {}),
        },
        scale: {
          ...structuredClone(DEFAULT_LAYER_SCALE),
          ...(((l as unknown) as { scale?: Partial<WebMapLayer['scale']> })
            .scale ?? {}),
        },
        style: {
          ...structuredClone(DEFAULT_LAYER_STYLE),
          ...(l.style ?? {}),
          point: {
            ...structuredClone(DEFAULT_LAYER_STYLE.point),
            ...(l.style?.point ?? {}),
          },
        },
        opacity: typeof l.opacity === 'number' ? l.opacity : 1,
        visible: l.visible ?? true,
      } as WebMapLayer;
    });
    return {
      ...DEFAULT_WEB_MAP,
      ...initial,
      search: {
        ...DEFAULT_WEB_MAP.search,
        ...(initial.search ?? {}),
      },
      layers,
    };
  }, [initial]);
  const [map, setMap] = useState<WebMapData>(seed);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const canvasRef = useRef<MapCanvasHandle | null>(null);

  /**
   * Shared selection state: per-layer set of feature ids. Because
   * every geojson source is added with `generateId: true`, these ids
   * are the same as the feature's array index in the cached
   * FeatureCollection — which is what the attribute table uses for
   * its row selection. That alignment lets one Set serve both the
   * map highlight and the table checkboxes without translation.
   */
  const [selection, setSelection] = useState<Record<string, Set<number>>>({});

  // Drop selection for layers that have been removed so the state
  // doesn't leak references. Only runs when the layer-id set changes.
  const layerIdKey = map.layers.map((l) => l.id).join('|');
  useEffect(() => {
    const known = new Set(map.layers.map((l) => l.id));
    setSelection((prev) => {
      let changed = false;
      const next: Record<string, Set<number>> = {};
      for (const [id, set] of Object.entries(prev)) {
        if (known.has(id)) next[id] = set;
        else changed = true;
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerIdKey]);

  /**
   * Per-layer field + value metadata, populated lazily when a layer is
   * first seen. Used by the filter pick-list and the unique-values
   * renderer. Keyed by layer id; entries live as long as the layer does.
   */
  const [metadata, setMetadata] = useState<Record<string, LayerMetadata>>({});

  // Feature collections per layer, derived from metadata so the
  // attribute table and any future feature consumers don't refetch.
  // This keeps fetch cost to one round-trip per layer source change.
  const featuresByLayer = useMemo(() => {
    const out: Record<string, GeoJSON.FeatureCollection | null> = {};
    for (const [id, md] of Object.entries(metadata)) {
      out[id] = md.featureCollection;
    }
    return out;
  }, [metadata]);
  // AbortControllers per layer so a rapid edit-churn doesn't leave us
  // with in-flight fetches scribbling over newer state.
  const abortsRef = useRef<Record<string, AbortController>>({});

  // Discover metadata for any layer we haven't seen yet. The key here is
  // layer id + a stable hash of the source — if a user swaps the URL in
  // place we need a fresh fetch, not a stale cache.
  const sourceKeys = map.layers.map(
    (l) => `${l.id}|${JSON.stringify(l.source)}`,
  );
  const sourceKeysJoined = sourceKeys.join('\n');
  useEffect(() => {
    const seen = new Set(sourceKeys.map((k) => k.split('|')[0]));
    // Drop metadata for layers that were removed.
    setMetadata((prev) => {
      const next: Record<string, LayerMetadata> = {};
      for (const [id, md] of Object.entries(prev)) {
        if (seen.has(id)) next[id] = md;
      }
      return next;
    });

    for (const layer of map.layers) {
      const existing = metadata[layer.id];
      if (existing && !existing.loading && !existing.error) continue;
      // Cancel any previous fetch for this layer.
      abortsRef.current[layer.id]?.abort();
      const controller = new AbortController();
      abortsRef.current[layer.id] = controller;

      setMetadata((prev) => ({
        ...prev,
        [layer.id]: {
          fields: prev[layer.id]?.fields ?? [],
          valuesByField: prev[layer.id]?.valuesByField ?? {},
          sampleProperties: prev[layer.id]?.sampleProperties ?? null,
          featureCollection: prev[layer.id]?.featureCollection ?? null,
          geometryTypes: prev[layer.id]?.geometryTypes ?? new Set(),
          error: null,
          loading: true,
        },
      }));
      discoverLayerMetadata(layer, controller.signal).then((md) => {
        if (controller.signal.aborted) return;
        setMetadata((prev) => ({ ...prev, [layer.id]: md }));
      });
    }
    // Cleanup on unmount: abort all in-flight discoveries.
    return () => {
      for (const c of Object.values(abortsRef.current)) c.abort();
    };
    // We depend on the joined source key so this effect re-runs when a
    // layer is added / removed / has its source swapped. Adding metadata
    // itself would cause infinite loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKeysJoined]);

  function markDirty() {
    setDirty(true);
    setSaved(false);
  }

  function setBasemap(basemap: BasemapKey) {
    setMap((m) => ({ ...m, basemap }));
    markDirty();
  }

  function setLayers(next: WebMapLayer[]) {
    setMap((m) => ({ ...m, layers: next }));
    markDirty();
  }

  function addLayer(layer: WebMapLayer) {
    setMap((m) => ({ ...m, layers: [layer, ...m.layers] }));
    markDirty();
  }

  // Camera changes from user interaction get folded into the canonical
  // state so Save view captures whatever the user is currently looking at.
  const onCameraChange = useCallback(
    (next: Pick<WebMapData, 'center' | 'zoom' | 'bearing' | 'pitch'>) => {
      setMap((m) => ({ ...m, ...next }));
      if (canEdit) markDirty();
    },
    [canEdit],
  );

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: map }),
      });
      if (!res.ok) {
        setError(`Save failed: ${res.status} ${await res.text()}`);
        return;
      }
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  }

  // Warn before navigating away with unsaved changes. Standard beforeunload
  // contract: set returnValue and return a truthy string.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  return (
    <div className="flex flex-col gap-3">
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-1 p-3 shadow-card">
          <label className="text-xs font-medium uppercase tracking-wide text-muted">
            Basemap
          </label>
          <select
            value={map.basemap}
            onChange={(e) => setBasemap(e.target.value as BasemapKey)}
            className="h-9 rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            {BASEMAP_KEYS.map((key) => (
              <option key={key} value={key}>
                {BASEMAPS[key].label}
              </option>
            ))}
          </select>
          <span className="hidden text-xs text-muted sm:inline">
            {BASEMAPS[map.basemap].description}
          </span>

          <div className="ml-auto flex items-center gap-2">
            <ToolbarToggle
              Icon={List}
              label="Legend"
              active={legendOpen}
              onClick={() => setLegendOpen((v) => !v)}
            />
            <ToolbarToggle
              Icon={Table}
              label="Attributes"
              active={tableOpen}
              onClick={() => setTableOpen((v) => !v)}
            />
            {saved ? (
              <span className="inline-flex items-center gap-1 text-xs text-success">
                <Check className="h-3.5 w-3.5" />
                Saved
              </span>
            ) : null}
            <button
              type="button"
              onClick={save}
              disabled={!dirty || saving}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save map
            </button>
          </div>
        </div>
      ) : (
        /* Non-edit toolbar still needs the viewer tools. */
        <div className="flex items-center justify-end gap-2">
          <ToolbarToggle
            Icon={List}
            label="Legend"
            active={legendOpen}
            onClick={() => setLegendOpen((v) => !v)}
          />
          <ToolbarToggle
            Icon={Table}
            label="Attributes"
            active={tableOpen}
            onClick={() => setTableOpen((v) => !v)}
          />
        </div>
      )}

      <div className="flex h-[600px] overflow-hidden rounded-lg border border-border shadow-card">
        <div className="w-80 shrink-0">
          <LayerPanel
            layers={map.layers}
            metadata={metadata}
            canEdit={canEdit}
            onOpenAdd={() => setAddOpen(true)}
            onChange={setLayers}
          />
        </div>
        <div className="relative min-w-0 flex-1 p-2">
          <MapCanvas
            ref={canvasRef}
            map={map}
            onCameraChange={onCameraChange}
            selection={selection}
          />
          {map.search?.enabled !== false ? (
            <SearchBar
              layers={map.layers}
              featuresByLayer={featuresByLayer}
              geocodingEnabled={map.search?.geocoding !== false}
              onPick={(r) => {
                canvasRef.current?.flyAndHighlight({
                  bbox: r.bbox,
                  center: r.center,
                  ...(r.kind === 'feature'
                    ? {
                        layerId: r.layerId,
                        featureProps: (r.feature.properties ?? {}) as Record<
                          string,
                          unknown
                        >,
                      }
                    : {}),
                });
              }}
            />
          ) : null}
          <Legend
            open={legendOpen}
            layers={map.layers}
            metadata={metadata}
            onClose={() => setLegendOpen(false)}
          />
          <AttributeTable
            open={tableOpen}
            layers={map.layers}
            featuresByLayer={featuresByLayer}
            metadata={metadata}
            canEdit={canEdit}
            selection={selection}
            setSelection={setSelection}
            onClose={() => setTableOpen(false)}
            onZoomTo={(bbox) => canvasRef.current?.zoomTo(bbox)}
            onPatchLayer={(layerId, patch) => {
              setLayers(
                map.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l)),
              );
            }}
          />
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}

      <AddLayerDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdd={addLayer}
      />
    </div>
  );
}

/**
 * Migrate older persisted labels. Pre-v2.5 the shape was
 * `{ field, ... }` with a single field name; v2.5 switched to
 * `{ template, offsetX, offsetY, ... }`. A non-empty `field` wraps
 * into `{{field}}`; missing offsets default to a small positive Y so
 * labels sit below point markers instead of on top of them.
 */
function hydrateLabels(
  raw: Record<string, unknown>,
): WebMapLayer['labels'] {
  const base = structuredClone(DEFAULT_LAYER_LABELS);
  const merged = { ...base, ...(raw as Partial<WebMapLayer['labels']>) };
  if (
    typeof (raw as { template?: unknown }).template !== 'string' &&
    typeof (raw as { field?: unknown }).field === 'string' &&
    (raw as { field: string }).field.length > 0
  ) {
    merged.template = `{{${(raw as { field: string }).field}}}`;
  }
  return merged;
}

function ToolbarToggle({
  Icon,
  label,
  active,
  onClick,
}: {
  Icon: typeof List;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium shadow-card ${
        active
          ? 'border-accent bg-accent/10 text-accent'
          : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}
