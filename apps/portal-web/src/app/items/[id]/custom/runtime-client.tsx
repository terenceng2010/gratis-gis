'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Image as ImageIcon,
  Layers as LayersIcon,
  Lasso,
  ListTree,
  Map as MapIcon,
  MousePointer2,
  Pentagon,
  Printer,
  Search as SearchIcon,
  Square as SquareIcon,
  Type as TypeIcon,
} from 'lucide-react';
import Link from 'next/link';
import type {
  CustomAppData,
  CustomWidget,
  CustomWidgetKind,
  MapData,
  MapLayer,
} from '@gratis-gis/shared-types';
import type { CustomBasemap } from '@/lib/custom-basemap';
import type { SelectToolMode } from '../map/select-tool';
import {
  MapCanvas,
  type MapCanvasHandle,
} from '../map/map-canvas';

/**
 * Custom Web App runtime client (#341). Renders a designed page's
 * widgets in their grid positions with real, bound implementations:
 *
 *   - Map: MapLibre via the shared MapCanvas, seeded from the
 *     resolved app-level mapData (basemap + viewport + targets).
 *     Each Map widget gets its own state so selections / basemaps
 *     drift independently in multi-map apps.
 *   - LayerList / Legend / BasemapGallery / Search / Print / Select:
 *     bound to a Map widget by id (auto-bound at design time when a
 *     single Map exists, manually picked otherwise). Each reads /
 *     mutates the bound map's state through CustomMapsContext.
 *   - AttributeTable: minimal table over the bound app target's
 *     features. Click a row to highlight on the synced map; full
 *     editing arrives if a future runtime exposes the shared
 *     AttributeTable component plumbing.
 *   - Text: markdown-rendered. Tiny inline parser (bold + italic +
 *     links + lists + headings) keeps the bundle small.
 *
 * Chart is a deferred placeholder; the runtime renders it as a
 * "ships next" tile rather than a broken widget.
 *
 * Architecture:
 *
 *   - Per-map state lives in a Record<mapWidgetId, MapState> at
 *     this client. CustomMapsContext exposes it + an update fn +
 *     a refs map (for fly-to / zoom-to from sibling widgets) so
 *     the widget components stay leaf-y and don't pass state
 *     around manually.
 *   - The server entry (run/page.tsx) pre-resolves the app's
 *     targets, basemaps, and starting MapData; this client is a
 *     dumb consumer.
 */

interface ResolvedAppTarget {
  dataLayerId: string;
  layerKey: string;
  title: string;
  /**
   * Pre-built MapLayer descriptor for this target. Each Map widget
   * starts with all of these in its mapData.layers; LayerList +
   * Legend reflect them.
   */
  mapLayer: MapLayer;
}

interface MapState {
  mapData: MapData;
  selection: Record<string, Set<number | string>>;
  selectTool: SelectToolMode;
}

interface CustomMapsCtx {
  states: Record<string, MapState>;
  update: (
    mapWidgetId: string,
    patch:
      | Partial<MapState>
      | ((cur: MapState) => MapState),
  ) => void;
  registerRef: (mapWidgetId: string, ref: RefObject<MapCanvasHandle>) => void;
  basemaps: CustomBasemap[];
  resolvedTargets: ResolvedAppTarget[];
  /** Fly the bound map's camera to a bbox via the registered ref. */
  flyTo: (
    mapWidgetId: string,
    bbox: [number, number, number, number],
  ) => void;
}

const CustomMapsContext = createContext<CustomMapsCtx | null>(null);

function useBoundMap(
  mapWidgetId: string,
): {
  state: MapState | null;
  update: (
    patch: Partial<MapState> | ((cur: MapState) => MapState),
  ) => void;
  basemaps: CustomBasemap[];
  resolvedTargets: ResolvedAppTarget[];
  flyTo: (bbox: [number, number, number, number]) => void;
} {
  const ctx = useContext(CustomMapsContext);
  if (!ctx) {
    throw new Error('useBoundMap called outside CustomMapsContext');
  }
  return {
    state: ctx.states[mapWidgetId] ?? null,
    update: (patch) => ctx.update(mapWidgetId, patch),
    basemaps: ctx.basemaps,
    resolvedTargets: ctx.resolvedTargets,
    flyTo: (bbox) => ctx.flyTo(mapWidgetId, bbox),
  };
}

interface Props {
  itemId: string;
  itemTitle: string;
  app: CustomAppData;
  basemaps: CustomBasemap[];
  baseMapData: MapData;
  resolvedTargets: ResolvedAppTarget[];
}

export function CustomRuntimeClient({
  itemId,
  itemTitle,
  app,
  basemaps,
  baseMapData,
  resolvedTargets,
}: Props) {
  // Multi-page support (#342). Track which page is showing; render
  // only that page's widgets, but seed map state from EVERY page so
  // a Map's layer toggles persist when the user switches pages and
  // comes back. Single-page apps skip the tab strip entirely.
  const [activePageIdx, setActivePageIdx] = useState(0);
  const safePageIdx = Math.min(activePageIdx, app.pages.length - 1);
  const page = app.pages[safePageIdx]!;
  const totalWidgets = app.pages.reduce((n, p) => n + p.widgets.length, 0);
  const usedRows = page.widgets.reduce(
    (n, w) => Math.max(n, w.layout.row + w.layout.rowSpan - 1),
    0,
  );
  const totalRows = Math.max(8, usedRows + 2);

  // Initial per-Map-widget state derived once from the resolved
  // baseMapData. Each Map widget gets a deep-ish copy so divergent
  // basemap / layer-visibility changes don't cross-contaminate. We
  // walk EVERY page so cross-page bindings + page-switch persistence
  // both work without re-initializing state mid-session.
  const [states, setStates] = useState<Record<string, MapState>>(() => {
    const out: Record<string, MapState> = {};
    for (const p of app.pages) {
      for (const w of p.widgets) {
        if (w.kind === 'map') {
          out[w.id] = {
            mapData: { ...baseMapData, layers: [...(baseMapData.layers ?? [])] },
            selection: {},
            selectTool: 'off',
          };
        }
      }
    }
    return out;
  });

  const update = useCallback(
    (
      mapWidgetId: string,
      patch:
        | Partial<MapState>
        | ((cur: MapState) => MapState),
    ) => {
      setStates((cur) => {
        const existing = cur[mapWidgetId];
        if (!existing) return cur;
        const next =
          typeof patch === 'function' ? patch(existing) : { ...existing, ...patch };
        return { ...cur, [mapWidgetId]: next };
      });
    },
    [],
  );

  // Map of widget-id to MapCanvasHandle ref. Each Map widget calls
  // registerRef on mount so other widgets can call zoomTo /
  // flyAndHighlight without prop-drilling.
  const refRegistry = useRef<Record<string, RefObject<MapCanvasHandle>>>({});
  const registerRef = useCallback(
    (id: string, ref: RefObject<MapCanvasHandle>) => {
      refRegistry.current[id] = ref;
    },
    [],
  );

  const flyTo = useCallback(
    (mapWidgetId: string, bbox: [number, number, number, number]) => {
      const ref = refRegistry.current[mapWidgetId];
      ref?.current?.zoomTo(bbox);
    },
    [],
  );

  const ctxValue: CustomMapsCtx = useMemo(
    () => ({
      states,
      update,
      registerRef,
      basemaps,
      resolvedTargets,
      flyTo,
    }),
    [states, update, registerRef, basemaps, resolvedTargets, flyTo],
  );

  return (
    <CustomMapsContext.Provider value={ctxValue}>
      <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col bg-surface-0">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface-1 px-4 py-2">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/items"
              className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to items
            </Link>
            <span className="text-muted">/</span>
            <span className="truncate text-base font-semibold text-ink-0">
              {itemTitle}
            </span>
          </div>
          <Link
            href={`/items/${itemId}`}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs font-medium text-ink-1 hover:bg-surface-2"
          >
            Configure
          </Link>
        </header>

        {/* Page tabs (#342). Hidden when the app has only one page so
            single-page apps stay chrome-free. */}
        {app.pages.length > 1 && (
          <nav
            className="flex shrink-0 items-end gap-0 overflow-x-auto border-b border-border bg-surface-1 px-3"
            aria-label="App pages"
          >
            {app.pages.map((p, i) => {
              const active = i === safePageIdx;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setActivePageIdx(i)}
                  aria-current={active ? 'page' : undefined}
                  className={`relative px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? 'text-ink-0'
                      : 'text-muted hover:text-ink-1'
                  }`}
                >
                  {p.title}
                  {active && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute -bottom-px left-2 right-2 h-0.5 rounded-full bg-ink-0"
                    />
                  )}
                </button>
              );
            })}
          </nav>
        )}

        <div className="relative flex-1 overflow-auto bg-surface-0 p-3">
          {totalWidgets === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="max-w-md rounded-lg border border-dashed border-border bg-surface-1 p-8 text-center shadow-card">
                <SquareIcon className="mx-auto h-8 w-8 text-muted" />
                <h2 className="mt-3 text-base font-semibold text-ink-0">
                  Empty app
                </h2>
                <p className="mt-2 text-sm text-muted">
                  Head back to{' '}
                  <Link
                    href={`/items/${itemId}`}
                    className="text-accent hover:underline"
                  >
                    the configuration page
                  </Link>{' '}
                  to drag a widget onto the canvas.
                </p>
              </div>
            </div>
          ) : (
            <div
              className="grid h-full w-full"
              style={{
                // #357: matches the designer's v2 grid (24 cols x
                // 24px rows). Old v1 apps are migrated on load via
                // migrateCustomAppData in the page entry, so the
                // runtime always sees v2 coordinates here.
                gridTemplateColumns: 'repeat(24, minmax(0, 1fr))',
                gridAutoRows: `minmax(24px, auto)`,
                minHeight: `${totalRows * 24}px`,
                gap: '6px',
              }}
            >
              {page.widgets.map((w) => (
                <WidgetSlot key={w.id} widget={w} />
              ))}
            </div>
          )}
        </div>
      </div>
    </CustomMapsContext.Provider>
  );
}

function WidgetSlot({ widget }: { widget: CustomWidget }) {
  return (
    <section
      style={{
        gridColumn: `${widget.layout.col} / span ${widget.layout.colSpan}`,
        gridRow: `${widget.layout.row} / span ${widget.layout.rowSpan}`,
      }}
      className="flex h-full w-full flex-col overflow-hidden rounded-md border border-border bg-surface-1"
    >
      {renderWidget(widget)}
    </section>
  );
}

function renderWidget(widget: CustomWidget): React.ReactNode {
  switch (widget.kind) {
    case 'map':
      return <MapWidgetRender key={widget.id} widget={widget} />;
    case 'legend':
      return <LegendWidgetRender widget={widget} />;
    case 'layer-list':
      return <LayerListWidgetRender widget={widget} />;
    case 'attribute-table':
      return <AttributeTableWidgetRender widget={widget} />;
    case 'text':
      return <TextWidgetRender widget={widget} />;
    case 'chart':
      return <ChartWidgetRender />;
    case 'search':
      return <SearchWidgetRender widget={widget} />;
    case 'print':
      return <PrintWidgetRender widget={widget} />;
    case 'select':
      return <SelectWidgetRender widget={widget} />;
    case 'basemap-gallery':
      return <BasemapGalleryWidgetRender widget={widget} />;
    default: {
      const _exhaustive: never = widget.kind;
      void _exhaustive;
      return null;
    }
  }
}

// ---- Map widget ------------------------------------------------------------

function MapWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.kind !== 'map') return null;
  const ctx = useContext(CustomMapsContext);
  const ref = useRef<MapCanvasHandle | null>(null);
  // Register the ref ONCE on mount so sibling widgets can use it
  // for fly-to. Re-registering on every render is harmless (same
  // ref object) but unnecessary.
  useEffect(() => {
    if (ctx) ctx.registerRef(widget.id, ref as RefObject<MapCanvasHandle>);
  }, [ctx, widget.id]);

  if (!ctx) return null;
  const state = ctx.states[widget.id];
  if (!state) return null;

  return (
    <div className="relative h-full w-full">
      <MapCanvas
        ref={ref}
        map={state.mapData}
        basemaps={ctx.basemaps}
        selection={state.selection}
        selectTool={state.selectTool}
        onCameraChange={(next) =>
          ctx.update(widget.id, (cur) => ({
            ...cur,
            mapData: { ...cur.mapData, ...next },
          }))
        }
        onSelectionChange={(next) =>
          ctx.update(widget.id, (cur) => ({ ...cur, selection: next }))
        }
        hideNavigationControl={
          widget.config.kind === 'map' && widget.config.showNavigation === false
        }
      />
    </div>
  );
}

// ---- LayerList widget ------------------------------------------------------

function LayerListWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'layer-list') return null;
  const { state, update } = useBoundMap(widget.config.mapWidgetId);
  const allowToggle = widget.config.allowToggle !== false;
  return (
    <WidgetFrame icon={LayersIcon} title="Layers">
      {!state ? (
        <p className="p-2 text-xs italic text-muted">No bound map.</p>
      ) : (state.mapData.layers ?? []).length === 0 ? (
        <p className="p-2 text-xs italic text-muted">No layers.</p>
      ) : (
        <ul className="space-y-0.5 p-1.5">
          {(state.mapData.layers ?? []).map((l) => (
            <li
              key={l.id}
              className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-surface-2"
            >
              <input
                type="checkbox"
                checked={l.visible !== false}
                disabled={!allowToggle}
                onChange={(e) =>
                  update((cur) => ({
                    ...cur,
                    mapData: {
                      ...cur.mapData,
                      layers: (cur.mapData.layers ?? []).map((x) =>
                        x.id === l.id ? { ...x, visible: e.target.checked } : x,
                      ),
                    },
                  }))
                }
                className="h-3 w-3"
              />
              <span className="flex-1 truncate text-ink-1" title={l.title}>
                {l.title}
              </span>
            </li>
          ))}
        </ul>
      )}
    </WidgetFrame>
  );
}

// ---- Legend widget ---------------------------------------------------------

function LegendWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'legend') return null;
  const { state } = useBoundMap(widget.config.mapWidgetId);
  return (
    <WidgetFrame icon={ListTree} title="Legend">
      {!state ? (
        <p className="p-2 text-xs italic text-muted">No bound map.</p>
      ) : (
        <ul className="space-y-1 p-2">
          {(state.mapData.layers ?? [])
            .filter((l) => l.visible !== false)
            .map((l) => (
              <li
                key={l.id}
                className="flex items-center gap-2 text-xs text-ink-1"
              >
                <span
                  className="inline-block h-3 w-3 shrink-0 rounded-full border border-border"
                  style={{
                    backgroundColor:
                      l.style?.point?.color ??
                      l.style?.line?.color ??
                      l.style?.polygon?.fillColor ??
                      '#6366f1',
                  }}
                />
                <span className="truncate" title={l.title}>
                  {l.title}
                </span>
              </li>
            ))}
        </ul>
      )}
    </WidgetFrame>
  );
}

// ---- BasemapGallery widget -------------------------------------------------

function BasemapGalleryWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'basemap-gallery') return null;
  const { state, update, basemaps } = useBoundMap(widget.config.mapWidgetId);
  // Bind to a local so the narrowed type carries into the filter closure.
  const explicitIds = widget.config.basemapIds;
  const visibleBasemaps =
    Array.isArray(explicitIds) && explicitIds.length > 0
      ? basemaps.filter((b) => explicitIds.includes(b.id))
      : basemaps;
  const activeId = state?.mapData.basemap ?? '';
  return (
    <WidgetFrame icon={ImageIcon} title="Basemaps">
      {visibleBasemaps.length === 0 ? (
        <p className="p-2 text-xs italic text-muted">No basemaps available.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-1.5 p-2">
          {visibleBasemaps.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() =>
                  update((cur) => ({
                    ...cur,
                    mapData: { ...cur.mapData, basemap: b.id },
                  }))
                }
                className={`flex w-full flex-col items-stretch gap-1 rounded-md border-2 p-1 text-left text-[10px] transition ${
                  activeId === b.id
                    ? 'border-accent bg-accent/5'
                    : 'border-border bg-surface-1 hover:border-accent/40'
                }`}
                title={b.label}
              >
                {b.thumbnailUrl ? (
                  <img
                    src={b.thumbnailUrl}
                    alt={b.label}
                    className="h-12 w-full rounded object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-12 items-center justify-center rounded bg-surface-2">
                    <MapIcon className="h-4 w-4 text-muted" />
                  </div>
                )}
                <span className="truncate text-ink-1">{b.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </WidgetFrame>
  );
}

// ---- Search widget ---------------------------------------------------------

function SearchWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'search') return null;
  const { state, flyTo } = useBoundMap(widget.config.mapWidgetId);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!state || !q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/geocode?q=${encodeURIComponent(q.trim())}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Array<{
        bbox?: [number, number, number, number];
        lat?: number;
        lon?: number;
      }>;
      const top = data[0];
      if (!top) {
        setError('No results');
        return;
      }
      if (top.bbox) {
        flyTo(top.bbox);
      } else if (typeof top.lat === 'number' && typeof top.lon === 'number') {
        const d = 0.01;
        flyTo([top.lon - d, top.lat - d, top.lon + d, top.lat + d]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <WidgetFrame icon={SearchIcon} title="Search">
      <form onSubmit={onSubmit} className="flex flex-col gap-1 p-2">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={
            widget.config.geocodingEnabled === false
              ? 'Search layer attributes…'
              : 'Search address or attributes…'
          }
          disabled={busy || !state}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
        />
        {error ? (
          <p className="text-[10px] text-rose-600">{error}</p>
        ) : (
          <p className="text-[10px] text-muted">
            {state
              ? 'Press Enter to search.'
              : 'Bind to a Map widget to enable.'}
          </p>
        )}
      </form>
    </WidgetFrame>
  );
}

// ---- Print widget ----------------------------------------------------------

function PrintWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'print') return null;
  const { state } = useBoundMap(widget.config.mapWidgetId);
  return (
    <WidgetFrame icon={Printer} title="Print">
      <div className="flex h-full flex-col items-center justify-center gap-2 p-2">
        <button
          type="button"
          disabled={!state}
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          title={state ? 'Print this page' : 'Bind a Map widget first'}
        >
          <Printer className="h-3.5 w-3.5" />
          Print
        </button>
      </div>
    </WidgetFrame>
  );
}

// ---- Select widget ---------------------------------------------------------

// 'off' is the unselected state for the tool; the panel never shows
// it, so type SELECT_MODES with the narrow union the config uses.
type ActiveSelectMode = Exclude<SelectToolMode, 'off'>;

const SELECT_MODES: Array<{
  mode: ActiveSelectMode;
  label: string;
  Icon: typeof MousePointer2;
}> = [
  { mode: 'click', label: 'Click', Icon: MousePointer2 },
  { mode: 'rectangle', label: 'Box', Icon: SquareIcon },
  { mode: 'polygon', label: 'Polygon', Icon: Pentagon },
  { mode: 'lasso', label: 'Lasso', Icon: Lasso },
];

function SelectWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'select') return null;
  const { state, update } = useBoundMap(widget.config.mapWidgetId);
  const allowedModes: Array<ActiveSelectMode> =
    widget.config.modes ?? ['click', 'rectangle', 'polygon', 'lasso'];
  const visible = SELECT_MODES.filter((m) => allowedModes.includes(m.mode));
  const active = state?.selectTool ?? 'off';
  return (
    <WidgetFrame icon={MousePointer2} title="Select">
      <div className="flex flex-wrap items-center gap-1 p-2">
        {visible.map(({ mode, label, Icon }) => (
          <button
            key={mode}
            type="button"
            disabled={!state}
            onClick={() =>
              update((cur) => ({
                ...cur,
                selectTool: cur.selectTool === mode ? 'off' : mode,
              }))
            }
            className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium ${
              active === mode
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
            } disabled:opacity-50`}
            title={label}
          >
            <Icon className="h-3 w-3" />
            {label}
          </button>
        ))}
      </div>
    </WidgetFrame>
  );
}

// ---- AttributeTable widget -------------------------------------------------

interface FetchedFeatures {
  loading: boolean;
  rows: Array<{ id: string | number; props: Record<string, unknown> }>;
  fields: string[];
  error: string | null;
}

function AttributeTableWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'attribute-table') return null;
  const ctx = useContext(CustomMapsContext);
  const target = ctx?.resolvedTargets[widget.config.targetIndex] ?? null;
  const [data, setData] = useState<FetchedFeatures>({
    loading: true,
    rows: [],
    fields: [],
    error: null,
  });
  const maxRows = widget.config.maxRows ?? 200;

  useEffect(() => {
    if (!target) {
      setData({ loading: false, rows: [], fields: [], error: 'No target' });
      return;
    }
    let abort = false;
    setData({ loading: true, rows: [], fields: [], error: null });
    void (async () => {
      try {
        const url = `/api/portal/items/${target.dataLayerId}/layers/${target.layerKey}/geojson`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const fc = (await res.json()) as GeoJSON.FeatureCollection;
        if (abort) return;
        const features = (fc.features ?? []).slice(0, maxRows);
        const fieldSet = new Set<string>();
        for (const f of features) {
          for (const k of Object.keys(f.properties ?? {})) fieldSet.add(k);
        }
        const fields = Array.from(fieldSet).filter((f) => !f.startsWith('_'));
        setData({
          loading: false,
          rows: features.map((f) => ({
            id: (f.id ?? '') as string | number,
            props: (f.properties ?? {}) as Record<string, unknown>,
          })),
          fields,
          error: null,
        });
      } catch (err) {
        if (abort) return;
        setData({
          loading: false,
          rows: [],
          fields: [],
          error: err instanceof Error ? err.message : 'Fetch failed',
        });
      }
    })();
    return () => {
      abort = true;
    };
  }, [target, maxRows]);

  return (
    <WidgetFrame icon={LayersIcon} title="Attribute Table">
      {data.loading ? (
        <p className="p-2 text-xs italic text-muted">Loading…</p>
      ) : data.error ? (
        <p className="p-2 text-xs text-rose-600">{data.error}</p>
      ) : data.rows.length === 0 ? (
        <p className="p-2 text-xs italic text-muted">No features.</p>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="min-w-full border-collapse text-[11px]">
            <thead className="sticky top-0 z-10 bg-surface-2">
              <tr>
                {data.fields.map((f) => (
                  <th
                    key={f}
                    className="border-b border-border px-2 py-1 text-left font-medium text-ink-1"
                  >
                    {f}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr
                  key={`${r.id}:${i}`}
                  className="border-b border-border hover:bg-surface-2"
                >
                  {data.fields.map((f) => (
                    <td
                      key={f}
                      className="whitespace-nowrap px-2 py-1 text-ink-1"
                    >
                      {formatCell(r.props[f])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </WidgetFrame>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---- Text widget -----------------------------------------------------------

const TEXT_PRESET_CLS: Record<string, string> = {
  header: 'text-2xl font-bold text-ink-0',
  subheader: 'text-lg font-semibold text-ink-0',
  body: 'text-sm text-ink-1',
  callout: 'rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900',
};

function TextWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'text') return null;
  const cls = TEXT_PRESET_CLS[widget.config.preset ?? 'body'] ?? '';
  return (
    <div className={`h-full w-full overflow-auto p-3 ${cls}`}>
      <MarkdownLite text={widget.config.markdown} />
    </div>
  );
}

/**
 * Tiny inline markdown renderer (#341). Handles paragraphs, **bold**,
 * *italic*, `code`, [text](url), - / * unordered lists, and
 * `# / ## / ###` headings. Anything else renders as plain text.
 * Avoids pulling a 50KB markdown library for a widget that's
 * almost always one paragraph long.
 */
function MarkdownLite({ text }: { text: string }) {
  const blocks = text.split(/\n\n+/);
  return (
    <>
      {blocks.map((block, i) => {
        const t = block.trim();
        if (!t) return null;
        if (t.startsWith('### ')) {
          return (
            <h3 key={i} className="mb-2 text-base font-semibold text-ink-0">
              {renderInline(t.slice(4))}
            </h3>
          );
        }
        if (t.startsWith('## ')) {
          return (
            <h2 key={i} className="mb-2 text-lg font-bold text-ink-0">
              {renderInline(t.slice(3))}
            </h2>
          );
        }
        if (t.startsWith('# ')) {
          return (
            <h1 key={i} className="mb-2 text-xl font-bold text-ink-0">
              {renderInline(t.slice(2))}
            </h1>
          );
        }
        const lines = t.split('\n');
        if (lines.every((l) => /^[-*]\s/.test(l))) {
          return (
            <ul key={i} className="mb-2 ml-5 list-disc space-y-0.5">
              {lines.map((l, j) => (
                <li key={j}>{renderInline(l.replace(/^[-*]\s/, ''))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="mb-2 whitespace-pre-wrap">
            {renderInline(t)}
          </p>
        );
      })}
    </>
  );
}

function renderInline(s: string): React.ReactNode {
  // Order matters: links first, then bold, italic, code. We split
  // on each pattern in a single pass via a regex.
  const tokens: React.ReactNode[] = [];
  const re =
    /(\[([^\]]+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) tokens.push(s.slice(last, m.index));
    if (m[1]) {
      tokens.push(
        <a
          key={key++}
          href={m[3]}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          {m[2]}
        </a>,
      );
    } else if (m[4]) {
      tokens.push(
        <strong key={key++} className="font-semibold">
          {m[5]}
        </strong>,
      );
    } else if (m[6]) {
      tokens.push(
        <em key={key++} className="italic">
          {m[7]}
        </em>,
      );
    } else if (m[8]) {
      tokens.push(
        <code
          key={key++}
          className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.95em]"
        >
          {m[9]}
        </code>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) tokens.push(s.slice(last));
  return <>{tokens}</>;
}

// ---- Chart widget (deferred placeholder) -----------------------------------

function ChartWidgetRender() {
  return (
    <WidgetFrame icon={ChevronRight} title="Chart">
      <p className="p-2 text-xs italic text-muted">
        Chart rendering ships in a follow-up slice.
      </p>
    </WidgetFrame>
  );
}

// ---- Shared frame ----------------------------------------------------------

function WidgetFrame({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof MapIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <Icon className="h-3.5 w-3.5 text-muted" strokeWidth={1.75} />
        <span className="font-medium text-ink-0">{title}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {children}
      </div>
    </>
  );
}

// Keep a kind icon registry just for static/lookup; not currently
// used by the renderer above but parallels the designer's
// PALETTE_TILES so a future "WidgetFrame defaults to kind icon"
// refactor stays cheap.
export const KIND_ICON: Record<CustomWidgetKind, typeof MapIcon> = {
  map: MapIcon,
  legend: ListTree,
  'layer-list': LayersIcon,
  'attribute-table': LayersIcon,
  text: TypeIcon,
  chart: ChevronRight,
  search: SearchIcon,
  print: Printer,
  select: MousePointer2,
  'basemap-gallery': ImageIcon,
};
