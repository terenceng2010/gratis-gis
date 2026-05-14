// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import {
  ArrowLeft,
  Bookmark as BookmarkIcon,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Crosshair as CrosshairIcon,
  Image as ImageIcon,
  Layers as LayersIcon,
  Lasso,
  ListTree,
  Loader2,
  Locate as LocateIcon,
  Map as MapIcon,
  MousePointer2,
  Pentagon,
  Printer,
  Search as SearchIcon,
  Square as SquareIcon,
  Table2 as TableIcon,
  Type as TypeIcon,
  X as XIcon,
} from 'lucide-react';
import Link from 'next/link';
import maplibregl from 'maplibre-gl';
// Recharts is imported as a namespace so the Chart widget can grab
// the pieces it needs without polluting the top-level import list.
// The bundler keeps the recharts chunk co-located with the chart
// widget's lexical reference; pages that never reach a chart-
// rendering widget don't pull the chunk.
import * as ReactRecharts from 'recharts';
import type {
  CustomAppData,
  CustomWidget,
  CustomWidgetKind,
  MapData,
  MapLayer,
  PanelAnchor,
  PanelArrangement,
} from '@gratis-gis/shared-types';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { customBasemapToData } from '@/lib/custom-basemap';
import { BasemapPreview } from '@/components/basemap-preview';
import type { SelectToolMode } from '../map/select-tool';
import { AttributeTable } from '../map/attribute-table';
import type { LayerMetadata } from '../map/layer-metadata';
import { SearchBar } from '../map/search-bar';
import {
  AppBar,
  AppBarContext,
  DockPanel,
  FoldableGroup,
  Slideout,
} from './themed-containers';
import {
  applyAppTheme,
  applyAppThemeTokens,
  resolveAssetRefSync,
  type AppThemeTokens,
} from '@gratis-gis/shared-types';
import { createPortal } from 'react-dom';
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
  /**
   * #361: jump to one of the app's pages by id. Used by the Button
   * widget's page-link path. Resolves the id to its index and falls
   * through silently if the page was deleted.
   */
  navigateToPage: (pageId: string) => void;
  pages: { id: string; title: string }[];
  /**
   * #361 part 2: live MapLibre Map instances keyed by Map widget id.
   * Populated by MapWidgetRender via MapCanvas's onMapReady callback.
   * Widgets that need direct access (Coordinates: mousemove tracking,
   * Bookmark: imperative flyTo, MyLocation: addSource/addLayer for the
   * marker) read from this map. Falls back to undefined when the
   * widget isn't mounted yet.
   */
  maps: Record<string, maplibregl.Map | null>;
  registerMap: (mapWidgetId: string, map: maplibregl.Map | null) => void;
  /**
   * #364: ref to the runtime grid container. Tool-mode popovers
   * with placement='floating' anchor against this so they stay
   * within the runtime even on a scrolling page. May be null until
   * the first render lands.
   */
  runtimeContainerRef: RefObject<HTMLDivElement>;
}

const CustomMapsContext = createContext<CustomMapsCtx | null>(null);

/**
 * Runtime-info context. Carries app-shell metadata that container
 * widgets (app-bar, etc.) want as fallbacks when their own config
 * leaves a slot blank (e.g. an app-bar with no `title` set should
 * fall back to the item's own title rather than render an empty
 * header. Keeping this separate from CustomMapsContext so a render
 * test that needs only the item title can mount one provider.
 */
interface RuntimeInfoCtx {
  itemTitle: string;
}
const RuntimeInfoContext = createContext<RuntimeInfoCtx | null>(null);

/**
 * #87 -- runtime time-travel context.  When `at` is set, every
 * data fetch in the runtime appends `?at=<ISO>` so the engine
 * returns the bitemporal "current truth" as of that moment.
 * Editing widgets (Create / Edit / Delete) read this same context
 * and disable themselves when `at` is non-null, since writing into
 * the past is intentionally rejected by the observation-log
 * engine.  A null `at` means "now" -- the default.
 */
interface AppTimeCtx {
  at: string | null;
  setAt: Dispatch<SetStateAction<string | null>>;
}
const AppTimeContext = createContext<AppTimeCtx>({
  at: null,
  setAt: () => {},
});

/**
 * Read the current app-time as an ISO string, or null if the app
 * is showing "now".  Layer fetches, chart fetches, attribute-table
 * fetches all gate their URL on this -- see appendAtParam.
 */
export function useAppTime(): string | null {
  return useContext(AppTimeContext).at;
}

/**
 * Append `at=<ISO>` to a URL when the app is in time-travel mode.
 * Returns the URL unchanged when `at` is null.  Centralises the
 * URL-building so we don't sprinkle the encoder logic across every
 * fetch site.
 */
export function appendAtParam(url: string, at: string | null): string {
  if (!at) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}at=${encodeURIComponent(at)}`;
}

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
  /**
   * #363: per-Map-widget MapData when the widget has its own
   * `config.mapId` override. Keyed by widget id. Widgets without an
   * override fall through to baseMapData. The server entry
   * (run/page.tsx) builds this map.
   */
  widgetMapData: Record<string, MapData>;
  resolvedTargets: ResolvedAppTarget[];
  /**
   * #22: theme tokens resolved server-side from the app's
   * themePresetId.  When present, the runtime applies these
   * directly (no client-side fetch needed).  Optional so older
   * call sites without theme plumbing still work; we fall back to
   * the built-in starter resolver in that case.
   */
  themeTokens?: AppThemeTokens['tokens'];
}

export function CustomRuntimeClient({
  itemId,
  itemTitle,
  app,
  basemaps,
  baseMapData,
  widgetMapData,
  resolvedTargets,
  themeTokens,
}: Props) {
  // Multi-page support (#342). Track which page is showing; render
  // only that page's widgets, but seed map state from EVERY page so
  // a Map's layer toggles persist when the user switches pages and
  // comes back. Single-page apps skip the tab strip entirely.
  const [activePageIdx, setActivePageIdx] = useState(0);
  // #364: runtime container ref. Tool-mode popovers anchor against
  // this so "fixed" placement docks to the runtime viewport rather
  // than the browser one.
  const runtimeContainerRef = useRef<HTMLDivElement | null>(null);
  // Theme root ref.  Applies CSS custom properties on the app
  // root so descendants reading `var(--app-*)` tokens render with
  // the configured theme.  When themeTokens are passed in
  // (server-resolved via theme items), use them directly via
  // applyAppThemeTokens; otherwise fall back to the built-in
  // starter resolver keyed off themePresetId.
  const themeRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!themeRootRef.current) return;
    if (themeTokens) {
      applyAppThemeTokens(themeRootRef.current, themeTokens);
    } else {
      applyAppTheme(themeRootRef.current, app.themePresetId);
    }
  }, [app.themePresetId, themeTokens]);
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
    function visit(widget: CustomWidget) {
      if (widget.kind === 'map') {
        // #363: prefer the per-widget MapData when an override is
        // resolved; fall back to the app-default baseMapData.
        const seed = widgetMapData[widget.id] ?? baseMapData;
        out[widget.id] = {
          mapData: { ...seed, layers: [...(seed.layers ?? [])] },
          selection: {},
          selectTool: 'off',
        };
      }
      // #362: recurse into Tabs containers so nested Map widgets
      // also get state entries.
      if (widget.kind === 'tabs' && widget.config.kind === 'tabs') {
        for (const t of widget.config.tabs) {
          for (const c of t.widgets) visit(c);
        }
      }
    }
    for (const p of app.pages) {
      for (const w of p.widgets) visit(w);
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

  // #361 part 2: live MapLibre Map instances per Map widget id.
  // MapWidgetRender registers via onMapReady so widgets like
  // Coordinates, Bookmark, and MyLocation can read pointer position,
  // call flyTo, or add temporary marker layers without a refRegistry
  // workaround.
  const [maps, setMaps] = useState<Record<string, maplibregl.Map | null>>({});
  const registerMap = useCallback(
    (id: string, map: maplibregl.Map | null) => {
      setMaps((cur) => {
        // Avoid resetting state when MapCanvas re-renders with the
        // same instance; React would otherwise schedule downstream
        // effects every render.
        if (cur[id] === map) return cur;
        return { ...cur, [id]: map };
      });
    },
    [],
  );

  // #361: navigate-by-id for the Button widget's page-link path.
  // Pages are passed as a stripped {id, title} list to avoid leaking
  // widget data into the context.
  const navigateToPage = useCallback(
    (pageId: string) => {
      const idx = app.pages.findIndex((p) => p.id === pageId);
      if (idx >= 0) setActivePageIdx(idx);
    },
    [app.pages],
  );
  const pagesForCtx = useMemo(
    () => app.pages.map((p) => ({ id: p.id, title: p.title })),
    [app.pages],
  );

  const ctxValue: CustomMapsCtx = useMemo(
    () => ({
      states,
      update,
      registerRef,
      basemaps,
      resolvedTargets,
      flyTo,
      navigateToPage,
      pages: pagesForCtx,
      maps,
      registerMap,
      runtimeContainerRef,
    }),
    [
      states,
      update,
      registerRef,
      basemaps,
      resolvedTargets,
      flyTo,
      navigateToPage,
      pagesForCtx,
      maps,
      registerMap,
    ],
  );

  // #87 -- app-time state.  Initial value read from the URL's
  // `?at=` query so deep-linking to a historical snapshot Just
  // Works.  Future commits add a slider widget that drives this
  // state imperatively.  Null = "now".
  const [appAt, setAppAt] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const raw = new URLSearchParams(window.location.search).get('at');
    if (!raw) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d.toISOString();
  });
  const appTimeCtx = useMemo(
    () => ({ at: appAt, setAt: setAppAt }),
    [appAt],
  );

  return (
    <AppTimeContext.Provider value={appTimeCtx}>
    <RuntimeInfoContext.Provider value={{ itemTitle }}>
    <CustomMapsContext.Provider value={ctxValue}>
      {/* Viewport-fit container. h-screen (was h-full + min-h) so
          the app's whole vertical extent is exactly the viewport
          height: header + page tabs (when present) + canvas slot
          all distribute within that, and the canvas slot's
          overflow-hidden keeps widgets from pushing the page taller.
          End users see the app fitted to their screen with no
          vertical scroll; widgets that have more content than they
          can show (an attribute table with many rows, a long layer
          list) handle their own internal scrolling. */}
      <div
        ref={themeRootRef}
        className="flex h-screen flex-col overflow-hidden bg-[hsl(var(--app-surface-0))] text-[hsl(var(--app-ink-0))]"
      >
        {appAt ? (
          // #87 -- time-travel banner.  Lives above the app header so
          // it's unmissable; the user understands they're not seeing
          // "live" data.  Read-only is also a hard rule: write
          // widgets gate on this context and disable themselves, and
          // the engine rejects writes that target past observations
          // independently of the UI.
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-300 bg-amber-100 px-4 py-1.5 text-xs text-amber-900">
            <span>
              Viewing as of{' '}
              <strong>{new Date(appAt).toLocaleString()}</strong>{' '}
              &ndash; read-only
            </span>
            <button
              type="button"
              onClick={() => setAppAt(null)}
              className="rounded-md border border-amber-400 bg-white px-2 py-0.5 text-amber-900 hover:bg-amber-50"
            >
              Return to Now
            </button>
          </div>
        ) : null}
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

        {/* Viewport-fit canvas (user feedback: apps should fit the
            screen, never scroll vertically). The parent is flex-1
            of a flex-col page (header + nav + this container), so
            its height resolves to "viewport - chrome". No
            overflow-auto -- if a widget's content exceeds its
            allotted grid cell, the widget handles its own internal
            scrolling. */}
        <div
          ref={runtimeContainerRef}
          className="relative flex flex-1 flex-col overflow-hidden bg-[hsl(var(--app-surface-0))]"
        >
          {totalWidgets === 0 ? (
            <div className="flex h-full items-center justify-center p-3">
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
          ) : (() => {
            // #22 final-mile: partition top-level widgets into the
            // CONTAINER slots (app-bar at top, dock-panels left/right)
            // and the CANVAS widgets (everything else). Containers
            // render in flex slots around the canvas, so collapsing a
            // dock actually frees up canvas space (the previous
            // approach embedded the dock inside a grid cell that
            // didn't change size when the dock collapsed, leaving a
            // hollow stripe of page background between the dock and
            // the map). Slideouts overlay the canvas at runtime, so
            // they pass through as canvas widgets and self-position.
            const ordered = sortForOverlapStacking(page.widgets);
            const topBars: CustomWidget[] = [];
            const leftDocks: CustomWidget[] = [];
            const rightDocks: CustomWidget[] = [];
            const canvasWidgets: CustomWidget[] = [];
            for (const w of ordered) {
              if (w.kind === 'app-bar') {
                topBars.push(w);
              } else if (
                w.kind === 'dock-panel' &&
                w.config.kind === 'dock-panel'
              ) {
                if (w.config.side === 'left') leftDocks.push(w);
                else rightDocks.push(w);
              } else {
                canvasWidgets.push(w);
              }
            }
            return (
              <>
                {topBars.map((w) => (
                  <div key={w.id} className="relative shrink-0">
                    {renderWidget(w)}
                  </div>
                ))}
                <div className="relative flex min-h-0 flex-1 items-stretch">
                  {leftDocks.map((w) => (
                    <div key={w.id} className="relative shrink-0">
                      {renderWidget(w)}
                    </div>
                  ))}
                  <div
                    className="relative grid min-h-0 min-w-0 flex-1 p-3"
                    style={{
                // Viewport-fit grid: 48 cols x N rows of 1fr each,
                // where N = the highest row+rowSpan used by any
                // widget. Rows are proportional (not pixel-fixed)
                // so the whole app fills the available viewport
                // height without scrolling. A widget at rowSpan=60
                // in a 64-row grid takes 60/64 = ~94% of the
                // canvas height; the same template on a taller or
                // shorter screen scales proportionally.
                //
                // Trade-off vs. the designer's 12px-row model:
                // the designer canvas is pixel-tall (designer
                // shows authoring affordances, room for the
                // user's eye to plan), but the runtime is
                // viewport-tall (end user sees a coherent app
                // fitted to their screen).
                gridTemplateColumns: 'repeat(48, minmax(0, 1fr))',
                gridTemplateRows: `repeat(${totalRows}, minmax(0, 1fr))`,
                //
                // The earlier 1400px fixed-width experiment was
                // reverted: it broke on narrow viewports (toolbar
                // widgets ended up off-screen) and made map-first
                // layouts feel cramped on wide displays. The new
                // direction is container widgets (app-bar,
                // dock-panel, slideout) that handle their own
                // responsive sizing inside the grid, so the grid
                // doesn't need a fixed width to look right.
                //
                // (gridTemplateColumns and gridTemplateRows are
                // declared above this block; this comment block
                // captures the historical context.)
                gap: '6px',
              }}
            >
                    {/* Canvas widgets paint via the page grid. Map
                        widgets sit at z-0; tool buttons at z-10;
                        other panels at z-5 (see WidgetSlot). */}
                    {canvasWidgets.map((w) => (
                      <WidgetSlot key={w.id} widget={w} />
                    ))}
                  </div>
                  {rightDocks.map((w) => (
                    <div key={w.id} className="relative shrink-0">
                      {renderWidget(w)}
                    </div>
                  ))}
                </div>
              </>
            );
          })()}
        </div>
      </div>
    </CustomMapsContext.Provider>
    </RuntimeInfoContext.Provider>
    </AppTimeContext.Provider>
  );
}

/**
 * Re-order widgets for runtime rendering so overlapping cells paint
 * in the right z-order. The persisted array order is the AUTHOR's
 * order (which determines selection-cycle, page navigation, etc. in
 * the designer); render order is independent.
 *
 * Rendering rule: Map widgets and Tabs containers paint UNDERNEATH
 * everything else. Without this, a user who drops a couple of
 * toolbar buttons and then adds a Map widget ends up with the Map
 * covering those buttons at runtime because the Map's section comes
 * LATER in DOM source order and CSS Grid paints later items on top.
 *
 * Within each tier we preserve the author's order so two overlapping
 * Map widgets (rare) still stack predictably and two overlapping
 * toolbar buttons (also rare; the designer doesn't auto-collide)
 * keep the author-visible order.
 */
function sortForOverlapStacking(widgets: CustomWidget[]): CustomWidget[] {
  const beneath: CustomWidget[] = [];
  const above: CustomWidget[] = [];
  for (const w of widgets) {
    if (w.kind === 'map' || w.kind === 'tabs') {
      beneath.push(w);
    } else {
      above.push(w);
    }
  }
  return [...beneath, ...above];
}

function WidgetSlot({ widget }: { widget: CustomWidget }) {
  // #364: tool-mode widgets render as a small icon button in the
  // grid cell + a popover panel anchored per panelArrangement.
  // Panel-mode widgets render inline using the existing card chrome.
  const isToolMode = isToolDisplayWidget(widget) && widgetDisplayMode(widget) === 'tool';
  // Stacking. Map and Tabs widgets (the "container" kinds) sit at
  // z-index 0; tool widgets sit at z-index 10; other panel widgets
  // sit at z-index 5. CSS Grid's source-order stacking is unreliable
  // when an overlapping child creates its own stacking context (e.g.
  // MapLibre's WebGL canvas via transform), so explicit z-index +
  // position: relative is needed to keep toolbar buttons above the
  // map when they overlap. The `position: relative` is required for
  // z-index to take effect on grid items.
  const isContainer = widget.kind === 'map' || widget.kind === 'tabs';
  const zIndex = isToolMode ? 10 : isContainer ? 0 : 5;
  return (
    <section
      style={{
        gridColumn: `${widget.layout.col} / span ${widget.layout.colSpan}`,
        gridRow: `${widget.layout.row} / span ${widget.layout.rowSpan}`,
        position: 'relative',
        zIndex,
      }}
      className={
        isToolMode
          ? 'flex h-full w-full items-stretch'
          : 'flex h-full w-full flex-col overflow-hidden rounded-md border border-border bg-surface-1'
      }
    >
      {isToolMode ? (
        <ToolWidgetSlot widget={widget} />
      ) : (
        renderWidget(widget)
      )}
    </section>
  );
}

const TOOL_DISPLAY_KINDS: ReadonlySet<CustomWidgetKind> = new Set([
  'layer-list',
  'legend',
  'search',
  'print',
  'select',
  'basemap-gallery',
  'bookmark',
  'coordinates',
  'my-location',
  // #261 follow-up: attribute-table now supports tool display mode so
  // authors can drop it onto the toolbar above the map. When
  // displayMode='tool' the runtime renders an icon button that opens
  // the table in a floating panel (anchored bottom-center by default,
  // matching the map item's dock).
  'attribute-table',
]);

function isToolDisplayWidget(widget: CustomWidget): boolean {
  return TOOL_DISPLAY_KINDS.has(widget.kind);
}

function widgetDisplayMode(widget: CustomWidget): 'panel' | 'tool' {
  if (!isToolDisplayWidget(widget)) return 'panel';
  const cfg = widget.config as { displayMode?: 'panel' | 'tool' };
  return cfg.displayMode ?? 'panel';
}

function widgetPanelArrangement(widget: CustomWidget): PanelArrangement {
  const cfg = widget.config as { panelArrangement?: PanelArrangement };
  return cfg.panelArrangement ?? {};
}

const KIND_TOOL_LABEL: Record<string, string> = {
  'layer-list': 'Layers',
  legend: 'Legend',
  search: 'Search',
  print: 'Print',
  select: 'Select',
  'basemap-gallery': 'Basemaps',
  bookmark: 'Bookmarks',
  coordinates: 'Coordinates',
  'my-location': 'My location',
  'attribute-table': 'Attribute table',
};

/**
 * #364: tool-mode wrapper. Renders an icon button in the canvas
 * grid cell. On click, opens a popover positioned per the widget's
 * panelArrangement, using the existing widget renderer for content.
 */
function ToolWidgetSlot({ widget }: { widget: CustomWidget }) {
  const ctx = useContext(CustomMapsContext);
  // When inside an app-bar, render the trigger as a flat header-ink
  // icon link rather than a raised white pill. The white-pill
  // treatment is correct on the canvas but reads as "stuck-on
  // buttons" when stacked on a colored header (the screenshot
  // showed Search/Basemap/Print/AttrTable as cramped white tiles
  // on the green Forest header).
  const inAppBar = useContext(AppBarContext);
  const [open, setOpen] = useState(false);
  // Trigger ref so the popover can anchor itself below the actual
  // button instead of always pinning to the runtime container's
  // top edge. Without this, a tool button inside an app-bar opens
  // a popover that overlaps the bar (anchored at top-right of the
  // runtime, which IS the bar's vertical band).
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const Icon = KIND_ICON[widget.kind] ?? SquareIcon;
  const label = KIND_TOOL_LABEL[widget.kind] ?? widget.kind;
  const arrangement = widgetPanelArrangement(widget);
  const iconOnly = arrangement.labelMode === 'icon-only';

  // Esc closes; click outside closes (handled by ToolPopover via
  // an overlay catcher).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-pressed={open}
        title={label}
        // For in-bar buttons we use inline `style` for the active
        // colors because Tailwind's arbitrary-value JIT was silently
        // failing on `bg-[hsl(var(--app-header-ink))]` in production
        // (cream + sage inversion never rendered, the button
        // appeared invisible on the green header). Inline style
        // sidesteps that entirely. Inactive state stays in classes
        // because the simpler color-only Tailwind utilities work
        // fine for it.
        style={
          inAppBar && open
            ? {
                backgroundColor: 'hsl(var(--app-header-ink))',
                color: 'hsl(var(--app-header-bg))',
              }
            : undefined
        }
        className={
          inAppBar
            ? // Flat header-ink treatment for tools sitting in an
              // app-bar. Idle: 85%-opacity header-ink (cream on
              // green for Forest). Active: INVERTED via inline
              // style above (cream BG, sage ink). The previous
              // attempt used Tailwind arbitrary values for active
              // which the JIT scanner missed at build time.
              `group/tool flex h-full min-w-[64px] flex-col items-center justify-center gap-0.5 rounded-md px-2.5 py-1.5 transition-colors ${
                open
                  ? ''
                  : 'text-[hsl(var(--app-header-ink)/0.85)] hover:bg-[hsl(var(--app-header-ink)/0.12)] hover:text-[hsl(var(--app-header-ink))]'
              }`
            : // Canvas treatment: raised white pill with shadow.
              // This is the right read when the trigger sits on the
              // page grid (surface-0) without surrounding chrome.
              `group/tool flex h-full w-full flex-col items-center justify-center gap-0.5 rounded-md border bg-surface-1 shadow-sm transition-all ${
                open
                  ? 'border-ink-0 text-ink-0 ring-2 ring-ink-0/10'
                  : 'border-border text-ink-1 hover:-translate-y-0.5 hover:border-ink-1 hover:shadow-md'
              }`
        }
      >
        <Icon
          className={`h-5 w-5 transition-transform ${
            open ? 'scale-110' : 'group-hover/tool:scale-105'
          }`}
          strokeWidth={1.75}
        />
        {/* labelMode='icon-only' compresses the button to just the
            icon; the title attribute above keeps discoverability via
            hover tooltip + screen-reader aria-label. */}
        {iconOnly ? null : (
          <span className="text-[10px] font-medium leading-none">{label}</span>
        )}
      </button>
      {open && ctx && (
        <ToolPopover
          arrangement={arrangement}
          containerRef={ctx.runtimeContainerRef}
          triggerRef={triggerRef}
          triggerInAppBar={inAppBar}
          title={label}
          icon={Icon}
          onClose={() => setOpen(false)}
        >
          {/* #364: suppress the inner widget's header so we don't
              stack two title bars on top of each other. The
              ToolPopoverHeader carries the title; WidgetFrame
              checks this context and skips its own header. */}
          <SuppressFrameHeaderContext.Provider value={true}>
            <div className="flex h-full min-h-0 flex-col">
              {renderWidget(widget)}
            </div>
          </SuppressFrameHeaderContext.Provider>
        </ToolPopover>
      )}
    </>
  );
}

/**
 * Anchored, animated popover for tool-mode widgets. Positions
 * itself at one of the 9 anchor cells of the runtime container
 * (or browser viewport if placement='fixed'), with optional
 * fade/slide animation on open.
 */
function ToolPopover({
  arrangement,
  containerRef,
  triggerRef,
  triggerInAppBar,
  title,
  icon: Icon,
  onClose,
  children,
}: {
  arrangement: PanelArrangement;
  containerRef: RefObject<HTMLDivElement>;
  /**
   * Trigger button ref. When set, the floating popover anchors
   * below the button (right-aligned to its right edge) instead of
   * pinning to the runtime container's anchor corner. This is what
   * stops a tool button inside an app-bar from opening a popover
   * that overlaps the bar itself.
   */
  triggerRef?: RefObject<HTMLButtonElement>;
  /**
   * When the trigger lives inside an app-bar, the popover wants
   * extra vertical clearance under the bar (so it visually aligns
   * with maplibre zoom controls) and extra horizontal inset on
   * right-anchored placements (so it doesn't bleed into the
   * zoom/compass control cluster). Caller passes this flag down so
   * computePopoverPosition can apply those offsets.
   */
  triggerInAppBar?: boolean;
  title: string;
  icon: typeof MapIcon;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const placement = arrangement.placement ?? 'floating';
  const anchor: PanelAnchor = arrangement.anchor ?? 'top-right';
  const width = arrangement.width ?? 360;
  const height = arrangement.height ?? 480;
  const offsetX = arrangement.offsetX ?? 12;
  const offsetY = arrangement.offsetY ?? 12;
  const animation = arrangement.animation ?? 'fade';

  // Brief delay before applying the "open" class so the CSS
  // transition runs even though we mounted with the panel
  // already in the DOM.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setShown(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  // Animate-out on close: flip shown off, wait the transition
  // duration, then call onClose. The parent unmounts us synchronously
  // today, but doing it this way lets a future "close on click
  // outside" path benefit from the same animation.
  function handleClose() {
    setShown(false);
    window.setTimeout(onClose, 160);
  }

  // Click-outside via a transparent backdrop. Lower z-index than
  // the popover itself so the popover stays interactive.
  // When a triggerRef is provided AND placement is floating, anchor
  // the popover to the trigger button's actual rect (drop below the
  // button, align with its right edge by default). This is the path
  // that stops app-bar tools from opening a popover that lands on
  // top of the bar itself. Falls back to the static anchor logic
  // when no trigger is available (or for fixed / docked-bottom).
  const positionStyle = computePopoverPosition({
    anchor,
    width,
    height,
    offsetX,
    offsetY,
    triggerRef: triggerRef ?? null,
    containerRef,
    placement,
    triggerInAppBar: triggerInAppBar ?? false,
  });

  const animationClass =
    animation === 'none'
      ? 'transition-none'
      : animation === 'slide'
        ? `transition-[opacity,transform] duration-200 ease-out ${
            shown
              ? 'translate-y-0 scale-100 opacity-100'
              : '-translate-y-1 scale-95 opacity-0'
          }`
        : `transition-[opacity,transform] duration-150 ease-out ${
            shown ? 'scale-100 opacity-100' : 'scale-[0.97] opacity-0'
          }`;

  // Fixed mode pins to the browser viewport. Floating mode pins to
  // the runtime container so the popover stays inside the app's
  // space even on a scrolling page.
  const positionMode =
    placement === 'fixed'
      ? 'fixed'
      : 'absolute';

  // Docked-bottom: full-width strip along the bottom edge of the
  // runtime container, with a collapse/expand control in the header.
  // Mirrors the map item's attribute-table dock pattern. Anchor /
  // width / offsets are ignored here; only height applies.
  //
  // Portaling: the popover is rendered into the runtime container
  // (via createPortal) so its `position: absolute` resolves to the
  // runtime root rather than the nearest positioned ancestor of the
  // calling ToolWidgetSlot. Without the portal, a tool button
  // living inside an app-bar would have its docked-bottom panel
  // anchor to the BAR's bottom edge (a 48px-tall sliver), not to
  // the bottom of the whole runtime viewport.
  if (placement === 'docked-bottom') {
    const container = containerRef.current ?? null;
    if (!container) return null;
    return createPortal(
      <DockedBottomPopover
        title={title}
        icon={Icon}
        height={arrangement.height ?? 280}
        animationClass={animationClass}
        onClose={handleClose}
      >
        {children}
      </DockedBottomPopover>,
      container,
    );
  }

  // For floating, render relative to the runtime container so the
  // CSS anchors (top/right/bottom/left) line up. We achieve that by
  // creating an overlay div that's `position:absolute inset-0`
  // inside the container, then positioning the popover within it.
  // For fixed, we render directly with position:fixed.
  if (placement === 'fixed') {
    return (
      <>
        <button
          type="button"
          aria-label="Close"
          onClick={handleClose}
          className="fixed inset-0 z-40 cursor-default bg-transparent"
        />
        <div
          role="dialog"
          aria-label={title}
          style={{ ...positionStyle, position: 'fixed', width, height }}
          className={`z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-[0_10px_40px_-10px_rgba(15,15,16,0.25),_0_2px_8px_-2px_rgba(15,15,16,0.08)] ${animationClass}`}
        >
          <ToolPopoverHeader title={title} icon={Icon} onClose={handleClose} />
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </div>
      </>
    );
  }

  // Floating: render via portal into the runtime container so the
  // popover's CSS anchors (top/right/bottom/left) line up with the
  // runtime root, regardless of where the calling ToolWidgetSlot
  // sits in the DOM (top-level page grid, inside an app-bar's flex
  // row, inside a dock-panel's column, etc.).
  const container = containerRef.current ?? null;
  if (!container) return null;

  return createPortal(
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={handleClose}
        // Backdrop sits behind the popover but above page content,
        // catching click-outside without blocking ARIA focus.
        style={{ position: 'absolute', inset: 0 }}
        className="z-40 cursor-default bg-transparent"
      />
      <div
        role="dialog"
        aria-label={title}
        style={{
          ...positionStyle,
          position: positionMode,
          width,
          height,
        }}
        className={`z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-overlay ${animationClass}`}
      >
        <ToolPopoverHeader title={title} icon={Icon} onClose={handleClose} />
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </>,
    container,
  );
}

function ToolPopoverHeader({
  title,
  icon: Icon,
  onClose,
  collapsed,
  onToggleCollapsed,
}: {
  title: string;
  icon: typeof MapIcon;
  onClose: () => void;
  /** When provided, render a collapse/expand chevron alongside the
   *  close button. Used by the docked-bottom popover so the user can
   *  shrink the panel to a header sliver without dismissing it. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-3 py-2">
      <Icon className="h-4 w-4 text-muted" strokeWidth={1.75} />
      <span className="flex-1 truncate text-sm font-semibold text-ink-0">
        {title}
      </span>
      {onToggleCollapsed ? (
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
          aria-expanded={!collapsed}
          className="rounded p-1 text-muted transition-colors hover:bg-surface-2 hover:text-ink-1"
        >
          {collapsed ? (
            <ChevronUp className="h-3.5 w-3.5" strokeWidth={2} />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
          )}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close panel"
        className="-mr-1 rounded p-1 text-muted transition-colors hover:bg-surface-2 hover:text-ink-1"
      >
        <XIcon className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </header>
  );
}

/**
 * Docked-bottom popover. Full-width strip along the bottom of the
 * runtime container with a collapse handle in the header. Mirrors
 * the map item's attribute-table dock so attribute-table widgets
 * configured as `placement: 'docked-bottom'` render the same way the
 * user knows from the map viewer.
 *
 * Collapse state is local: an open panel shrinks to a header-only
 * sliver but the inner content stays mounted so per-instance state
 * (query, layer-pick, sort) survives the collapse.
 */
function DockedBottomPopover({
  title,
  icon,
  height,
  animationClass,
  onClose,
  children,
}: {
  title: string;
  icon: typeof MapIcon;
  height: number;
  animationClass: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  // Header row is approximately 36 px (py-2 + 16px content). When
  // collapsed we render at that height; expanded uses the configured
  // panel height.
  const HEADER_HEIGHT = 36;
  const effectiveHeight = collapsed ? HEADER_HEIGHT : Math.max(HEADER_HEIGHT, height);
  return (
    <div
      role="dialog"
      aria-label={title}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: effectiveHeight,
      }}
      className={`z-50 flex flex-col overflow-hidden border-t border-border bg-surface-1 shadow-overlay ${animationClass}`}
    >
      <ToolPopoverHeader
        title={title}
        icon={icon}
        onClose={onClose}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((v) => !v)}
      />
      {/* Content stays mounted while collapsed (just clipped) so the
          inner state (query strings, scroll position, etc.) doesn't
          reset every time the user toggles. */}
      <div
        className="min-h-0 flex-1 overflow-hidden"
        aria-hidden={collapsed}
        style={collapsed ? { visibility: 'hidden' } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Translate a 9-cell anchor + offset into CSS positioning rules.
 * Each anchor corresponds to a corner / edge of the parent.
 * Offsets nudge inward (positive value moves the panel away from
 * the anchored edge).
 */
function computePopoverPosition({
  anchor,
  width,
  height,
  offsetX,
  offsetY,
  triggerRef,
  containerRef,
  placement,
  triggerInAppBar,
}: {
  anchor: PanelAnchor;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  triggerRef?: RefObject<HTMLButtonElement> | null;
  containerRef?: RefObject<HTMLDivElement>;
  placement?: string;
  triggerInAppBar?: boolean;
}): React.CSSProperties {
  // Trigger-anchored path: when we have a trigger button and the
  // popover is floating, position the popover relative to the
  // trigger's bounding box (drop below it, right-aligned to its
  // right edge). This is what we want for AGO-style tool buttons:
  // the menu opens directly under the icon you just clicked, not
  // at a fixed corner of the app shell.
  if (
    triggerRef?.current &&
    containerRef?.current &&
    (placement === 'floating' || placement === undefined)
  ) {
    const trig = triggerRef.current.getBoundingClientRect();
    const cont = containerRef.current.getBoundingClientRect();
    // App-bar triggers want extra vertical breathing room so the
    // popover top sits clearly below the zoom controls (default
    // top: 10 inside the map, controls are ~30px tall). Non-bar
    // triggers stay tight (4px).
    const topGap = triggerInAppBar ? 24 : 4;
    const top = trig.bottom - cont.top + topGap;
    // Default to right-aligning the popover with the trigger button
    // for top-right anchors; left-align for top-left; center for the
    // rest. This keeps the popover visually attached to the button
    // edge the user actually clicked.
    const [, horiz] = anchor.split('-') as [string, string];
    const containerW = cont.width;
    let left: number;
    if (horiz === 'left') {
      left = Math.max(offsetX, trig.left - cont.left);
    } else if (horiz === 'right') {
      // Right-align: for app-bar triggers, anchor the popover's
      // right edge to the runtime container's right edge minus a
      // small inset that clears the maplibre zoom/compass cluster
      // (controls live at ~10px from the canvas right with ~30px
      // width). This way the popover lands in the same horizontal
      // region as the zoom controls regardless of which tool in
      // the bar opened it. For non-bar triggers (canvas tools),
      // keep the trigger-anchored behavior so the popover stays
      // attached to the button the user clicked.
      const desiredRight = triggerInAppBar
        ? containerW - 80
        : trig.right - cont.left;
      left = Math.min(
        Math.max(offsetX, desiredRight - width),
        containerW - width - offsetX,
      );
    } else {
      // Center on trigger's center.
      const center = (trig.left + trig.right) / 2 - cont.left;
      left = Math.min(
        Math.max(offsetX, center - width / 2),
        containerW - width - offsetX,
      );
    }
    // Keep the popover from running off the bottom of the runtime;
    // if the trigger is near the bottom, flip above the trigger.
    const containerH = cont.height;
    if (top + height > containerH - offsetY) {
      const flipped = trig.top - cont.top - height - 4;
      if (flipped >= offsetY) {
        return { top: flipped, left };
      }
    }
    return { top, left };
  }

  // Static-anchor fallback. Used for fixed-placement popovers and
  // for callers that didn't supply a triggerRef (legacy paths).
  const [vert, horiz] = anchor.split('-') as [
    'top' | 'middle' | 'bottom',
    'left' | 'center' | 'right',
  ];
  const style: React.CSSProperties = {};
  if (vert === 'top') style.top = offsetY;
  if (vert === 'bottom') style.bottom = offsetY;
  if (vert === 'middle') {
    style.top = '50%';
    style.transform = (style.transform ?? '') + ' translateY(-50%)';
  }
  if (horiz === 'left') style.left = offsetX;
  if (horiz === 'right') style.right = offsetX;
  if (horiz === 'center') {
    style.left = '50%';
    const t = style.transform ?? '';
    style.transform = (t ? `${t} ` : '') + 'translateX(-50%)';
  }
  // Reference width/height so a future tweak (e.g. clamping to
  // container bounds in the static path too) has them available
  // without changing the signature.
  void width;
  void height;
  return style;
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
      return <ChartWidgetRender widget={widget} />;
    case 'search':
      return <SearchWidgetRender widget={widget} />;
    case 'print':
      return <PrintWidgetRender widget={widget} />;
    case 'select':
      return <SelectWidgetRender widget={widget} />;
    case 'basemap-gallery':
      return <BasemapGalleryWidgetRender widget={widget} />;
    case 'image':
      return <ImageWidgetRender widget={widget} />;
    case 'button':
      return <ButtonWidgetRender widget={widget} />;
    case 'divider':
      return <DividerWidgetRender widget={widget} />;
    case 'embed':
      return <EmbedWidgetRender widget={widget} />;
    case 'bookmark':
      return <BookmarkWidgetRender widget={widget} />;
    case 'coordinates':
      return <CoordinatesWidgetRender widget={widget} />;
    case 'my-location':
      return <MyLocationWidgetRender widget={widget} />;
    case 'time-slider':
      return <TimeSliderWidgetRender widget={widget} />;
    case 'tabs':
      return <TabsWidgetRender widget={widget} />;
    // Themed-app containers. Each holds an array of child widgets
    // and renders them inside themed chrome (top bar, side dock,
    // slideout drawer, foldable group). The actual rendering lives
    // in themed-containers.tsx alongside the renderer registry.
    case 'app-bar':
      return <AppBarWidgetRender widget={widget} />;
    case 'dock-panel':
      return <DockPanelWidgetRender widget={widget} />;
    case 'slideout':
      return <SlideoutWidgetRender widget={widget} />;
    case 'foldable-group':
      return <FoldableGroupWidgetRender widget={widget} />;
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
  // #87 -- read the app-time so the bound MapCanvas threads `at`
  // into every data-layer tile URL + bbox geojson fetch.  Scrubbing
  // the slider triggers a re-render here, MapCanvas's `asOfTime`
  // prop changes, and MapLibre re-fetches tiles tagged with the new
  // timestamp.
  const appAt = useAppTime();
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
        // #361 part 2: surface the live MapLibre Map up to the
        // runtime context so sibling widgets (Coordinates, Bookmark,
        // MyLocation) can subscribe to events / addSource / flyTo
        // imperatively without prop-drilling.
        onMapReady={(map) => ctx.registerMap(widget.id, map)}
        hideNavigationControl={
          widget.config.kind === 'map' && widget.config.showNavigation === false
        }
        asOfTime={appAt}
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
          {(state.mapData.layers ?? []).map((l) => {
            // Legend swatch inline with the row. Falls back through
            // point > line > polygon-fill > a neutral indigo so
            // every layer renders some color cue rather than a blank
            // gap. Combining the swatch into the layer row replaces
            // the separate Legend widget that templates used to
            // stamp underneath the Layers list: same information,
            // half the vertical space, and the toggle + identity sit
            // on the same line.
            const swatchColor =
              l.style?.point?.color ??
              l.style?.line?.color ??
              l.style?.polygon?.fillColor ??
              '#6366f1';
            return (
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
                          x.id === l.id
                            ? { ...x, visible: e.target.checked }
                            : x,
                        ),
                      },
                    }))
                  }
                  className="h-3 w-3"
                />
                <span
                  aria-hidden
                  className="inline-block h-3 w-3 shrink-0 rounded-sm border border-border"
                  style={{ backgroundColor: swatchColor }}
                />
                <span className="flex-1 truncate text-ink-1" title={l.title}>
                  {l.title}
                </span>
              </li>
            );
          })}
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
                {/* #67: always render a live MapLibre preview of
                    the basemap.  The picker exists so users can
                    pick by appearance, which is a different consumer
                    context from the item card; deferring to the
                    item's thumbnailUrl (which #66 made point at the
                    designer-grammar SVG) defeats the whole purpose
                    of the picker.  Live previews are also cheap
                    enough at gallery scale -- a handful of small
                    MapLibre canvases, only mounted while the
                    picker is open. */}
                <div className="h-12 w-full overflow-hidden rounded">
                  <BasemapPreview
                    data={customBasemapToData(b)}
                    ariaLabel={`Preview of ${b.label}`}
                    className="h-full w-full"
                  />
                </div>
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

/**
 * Custom Web App search tool. Delegates to the same SearchBar
 * component the map editor uses, so the popover honors every
 * setting the author already configured on the bound map item:
 *
 *   - The map's Search Source (`map.search.geocoderId`) drives
 *     which geocoder runs.  Unset and `search.geocoding === true`
 *     falls back to Nominatim through /api/geocode.
 *     `search.geocoding === false` disables the address half
 *     entirely.
 *   - Each layer's Searchable interaction (`layer.search.enabled`
 *     + `fields` + `labelTemplate`) drives attribute search.
 *     Local layer search runs over the in-memory feature cache;
 *     ArcGIS REST layers are queried server-side; v3 data layers
 *     don't pre-warm in the Custom App runtime (no local cache),
 *     same as the AttributeTable widget.
 *   - The widget's own `geocodingEnabled === false` is treated as
 *     an explicit override that forces geocoding off even when
 *     the map allows it; absent or true inherits the map's
 *     setting.
 *
 * The previous implementation hand-rolled a /api/geocode probe
 * that ignored all of the above (and 404'd in deployments where
 * the route wasn't reachable from the runtime context); using
 * SearchBar fixes the 404 and gives the popover the rich
 * candidate list with grouped sections + keyboard nav.
 */
function SearchWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'search') return null;
  const cfg = widget.config;
  const ctx = useContext(CustomMapsContext);
  const mapWidgetId = cfg.mapWidgetId;
  const boundMapState = mapWidgetId ? ctx?.states[mapWidgetId] ?? null : null;
  const boundMapInstance = mapWidgetId ? ctx?.maps[mapWidgetId] ?? null : null;

  // Live viewport bbox so a configured geocoder can scope its
  // similarity scan to what the user is looking at.  Same moveend
  // pattern AttributeTableWidget uses; nullable until the map's
  // first idle.
  const [viewportBbox, setViewportBbox] = useState<
    [number, number, number, number] | null
  >(null);
  useEffect(() => {
    if (!boundMapInstance) {
      setViewportBbox(null);
      return;
    }
    const update = () => {
      const b = boundMapInstance.getBounds();
      setViewportBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    };
    update();
    boundMapInstance.on('moveend', update);
    return () => {
      boundMapInstance.off('moveend', update);
    };
  }, [boundMapInstance]);

  // Local feature cache is intentionally empty: v3 data layers
  // don't pre-warm in the Custom App runtime (mirrors the
  // AttributeTable widget), ArcGIS REST layers are queried
  // server-side via SearchBar's searchArcgisLayers path, and the
  // geocoder paths don't read the cache at all.  Pre-warming for
  // legacy GeoJSON sources can come later when those re-enter the
  // Custom App flow.
  const featuresByLayer = useMemo<
    Record<string, GeoJSON.FeatureCollection | null>
  >(() => ({}), []);

  if (!boundMapState || !mapWidgetId) {
    return (
      <WidgetFrame icon={SearchIcon} title="Search">
        <p className="p-3 text-xs italic text-muted">
          Bind to a Map widget to enable.
        </p>
      </WidgetFrame>
    );
  }

  const mapSearch = boundMapState.mapData.search;
  // Widget override beats inheritance only when it's an explicit
  // false; otherwise the map's setting wins (and the map defaults
  // geocoding on).
  const geocodingEnabled =
    cfg.geocodingEnabled !== false && mapSearch?.geocoding !== false;
  const geocoderItemId = mapSearch?.geocoderId;

  return (
    <WidgetFrame icon={SearchIcon} title="Search">
      <div className="p-2">
        <SearchBar
          embedded
          layers={boundMapState.mapData.layers}
          featuresByLayer={featuresByLayer}
          geocodingEnabled={geocodingEnabled}
          {...(geocoderItemId ? { geocoderItemId } : {})}
          viewportBbox={viewportBbox}
          onPick={(r) => {
            if (!ctx) return;
            if (r.bbox) {
              ctx.flyTo(mapWidgetId, r.bbox);
              return;
            }
            if (r.center) {
              // Small box around the center so flyTo gets a real
              // bbox.  Matches what the old probe did for bare
              // lat/lon hits.
              const [lng, lat] = r.center;
              const d = 0.01;
              ctx.flyTo(mapWidgetId, [lng - d, lat - d, lng + d, lat + d]);
            }
          }}
        />
      </div>
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

/**
 * Shared shape used by ChartWidgetRender (and previously by the
 * legacy AttributeTableWidgetRender) for its lazy GeoJSON fetch.
 * Phase 2 of the attribute-table swap moved the table off this
 * shape onto the rich AttributeTable, but Chart still consumes it.
 */
interface FetchedFeatures {
  loading: boolean;
  rows: Array<{ id: string | number; props: Record<string, unknown> }>;
  fields: string[];
  error: string | null;
}

/**
 * Custom Web App's attribute-table widget. Phase 2 swaps the previous
 * minimal HTML table for the rich AttributeTable component from the
 * map item, so the panel that opens when the user clicks the
 * attribute-table toolbar button looks and behaves identically to the
 * one in the map editor: layer picker dropdown across all the bound
 * map's queryable layers, text query bar, sort by column,
 * In-extent toggle, Show selected, server-paged mode for v3
 * data_layer sublayers (so the 1.4M-row parcels case stays fast),
 * Zoom-to-selection, "Use as filter".
 *
 * State sourcing:
 *
 *   - When the widget is bound to a Map widget via
 *     `syncWithMapWidgetId`, the table reads the bound map's layers,
 *     selection, and viewport bbox from CustomMapsContext. Clicking a
 *     row mutates the same selection state the map renders, so the
 *     feature highlights, layer access, view scope, and any other
 *     map-level concerns all stay coherent across the two widgets.
 *
 *   - When the widget is unbound (no `syncWithMapWidgetId`), the
 *     table falls back to a single-layer view of the widget's
 *     configured target with local selection state. Useful for
 *     pages that show a table without a paired map. The Zoom-to
 *     control no-ops in this mode (no map to fly).
 *
 * The widget passes `embedded={true}` so AttributeTable fills the
 * ToolPopover content area instead of bottom-docking, and so its own
 * close button is hidden (the popover provides one).
 */
function AttributeTableWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'attribute-table') return null;
  // Pin the narrowed config to a local so the useMemo / useCallback
  // closures below don't re-narrow `widget.config` (TS loses the
  // discriminant inside hook bodies otherwise).
  const cfg = widget.config;
  const ctx = useContext(CustomMapsContext);

  const mapWidgetId = cfg.syncWithMapWidgetId;
  const boundMapState = mapWidgetId ? ctx?.states[mapWidgetId] ?? null : null;
  const boundMapInstance = mapWidgetId ? ctx?.maps[mapWidgetId] ?? null : null;

  // Layers shown in the table's layer-picker dropdown. Bound to a
  // map: all the map's layers (the rich AttributeTable filters down
  // to queryable ones internally). Unbound: just the configured
  // target as a synthetic single-layer array.
  const layers = useMemo<MapLayer[]>(() => {
    if (boundMapState?.mapData.layers) return boundMapState.mapData.layers;
    if (!ctx) return [];
    const target = ctx.resolvedTargets[cfg.targetIndex];
    if (!target) return [];
    return [target.mapLayer];
  }, [boundMapState, ctx, cfg.targetIndex]);

  // Selection state. Shared with the bound map when present; the
  // table updates `MapState.selection` via the context's `update`
  // helper so the same Set drives both the table highlights and the
  // map's feature-state. Unbound: local React state.
  const [localSelection, setLocalSelection] = useState<
    Record<string, Set<number | string>>
  >({});
  const selection = boundMapState?.selection ?? localSelection;
  const setSelection: Dispatch<
    SetStateAction<Record<string, Set<number | string>>>
  > = useCallback(
    (update) => {
      if (mapWidgetId && ctx) {
        ctx.update(mapWidgetId, (cur) => ({
          ...cur,
          selection:
            typeof update === 'function'
              ? (update as (
                  s: Record<string, Set<number | string>>,
                ) => Record<string, Set<number | string>>)(cur.selection)
              : update,
        }));
        return;
      }
      setLocalSelection(update);
    },
    [ctx, mapWidgetId],
  );

  // Live map viewport bbox. Drives server-paged mode for v3
  // data_layer sublayers: when present, the table fetches rows in
  // the visible extent instead of materializing every row. Tracked
  // here via moveend so we update only after the pan/zoom settles
  // and don't churn the AttributeTable's fetch on every frame.
  const [mapBbox, setMapBbox] = useState<
    [number, number, number, number] | null
  >(null);
  useEffect(() => {
    if (!boundMapInstance) {
      setMapBbox(null);
      return;
    }
    const update = () => {
      const b = boundMapInstance.getBounds();
      setMapBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    };
    update();
    boundMapInstance.on('moveend', update);
    return () => {
      boundMapInstance.off('moveend', update);
    };
  }, [boundMapInstance]);

  // The configured target picks which layer the picker focuses on
  // first open. Beyond that the user can switch via the dropdown.
  const focusLayerId = useMemo(() => {
    if (!ctx) return null;
    const target = ctx.resolvedTargets[cfg.targetIndex];
    return target?.mapLayer.id ?? null;
  }, [ctx, cfg.targetIndex]);

  // Metadata is normally populated by the map canvas as it loads
  // each layer's features. The Custom App runtime doesn't carry an
  // equivalent populated map yet, but AttributeTable tolerates an
  // empty record (it just falls back to behavior that doesn't need
  // geometryType-aware features). Server-paged mode for v3 layers
  // doesn't depend on metadata at all.
  const metadata = useMemo<Record<string, LayerMetadata>>(() => ({}), []);

  // featuresByLayer is the client-side feature cache the legacy
  // (non-v3) sources rely on. We don't pre-warm it: for v3 data
  // layers (the modern case), the AttributeTable server-pages by
  // mapBbox automatically. Legacy sources would need a fetch here;
  // unblocking that path is filed as a follow-up.
  const featuresByLayer = useMemo<
    Record<string, GeoJSON.FeatureCollection | null>
  >(() => ({}), []);

  const onZoomTo = useCallback(
    (bbox: [number, number, number, number]) => {
      if (!mapWidgetId || !ctx) return;
      ctx.flyTo(mapWidgetId, bbox);
    },
    [ctx, mapWidgetId],
  );

  const onPatchLayer = useCallback(
    (layerId: string, patch: Partial<MapLayer>) => {
      if (!mapWidgetId || !ctx) return;
      ctx.update(mapWidgetId, (cur) => ({
        ...cur,
        mapData: {
          ...cur.mapData,
          layers: cur.mapData.layers.map((l) =>
            l.id === layerId ? { ...l, ...patch } : l,
          ),
        },
      }));
    },
    [ctx, mapWidgetId],
  );

  // No bound map = no usable table because the rich AttributeTable
  // expects a non-empty layers array. Show a friendly nudge so the
  // author knows what to wire up.
  if (layers.length === 0) {
    return (
      <p className="p-3 text-xs italic text-muted">
        Configure the widget&rsquo;s target layer (or bind to a Map
        widget that has layers) to populate the attribute table.
      </p>
    );
  }

  return (
    <AttributeTable
      embedded
      open
      layers={layers}
      featuresByLayer={featuresByLayer}
      metadata={metadata}
      canEdit={false}
      selection={selection}
      setSelection={setSelection}
      onClose={() => {
        /* The ToolPopover owns close; the embedded AttributeTable
           hides its own close button, so this is a no-op stub kept
           for the typed prop. */
      }}
      onZoomTo={onZoomTo}
      onPatchLayer={onPatchLayer}
      focusLayerId={focusLayerId}
      mapBbox={mapBbox}
    />
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

// ---- Chart widget ----------------------------------------------------------

/**
 * Chart widget. Reads features from the bound target layer, applies
 * the configured group-by + aggregate, and renders a single-series
 * bar / line / pie chart via Recharts. Counts work without a value
 * field; sum / avg / min / max require one (the designer's panel
 * already gates this so a misconfigured widget shouldn't reach the
 * runtime, but we double-check and surface a hint when it does).
 *
 * Recharts is dynamically imported via the static module
 * dependency, but mounted inside a ResponsiveContainer so the chart
 * fills its widget cell -- the Custom grid sizes cells in the page
 * layout, then the chart self-sizes within. Tooltip + axis labels
 * come from Recharts defaults; the bundle stays small (~80 KB
 * gzipped, gated to widgets that actually render charts).
 */
function ChartWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'chart') return null;
  const ctx = useContext(CustomMapsContext);
  // #87 -- read app-time so the chart re-fetches against the
  // bitemporal snapshot when the user scrubs back in time.
  const appAt = useAppTime();
  const cfg = widget.config;
  const target = ctx?.resolvedTargets[cfg.targetIndex] ?? null;
  const [data, setData] = useState<FetchedFeatures>({
    loading: true,
    rows: [],
    fields: [],
    error: null,
  });

  useEffect(() => {
    if (!target) {
      setData({ loading: false, rows: [], fields: [], error: 'No target' });
      return;
    }
    let abort = false;
    setData({ loading: true, rows: [], fields: [], error: null });
    void (async () => {
      try {
        const url = appendAtParam(
          `/api/portal/items/${target.dataLayerId}/layers/${target.layerKey}/geojson`,
          appAt,
        );
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const fc = (await res.json()) as GeoJSON.FeatureCollection;
        if (abort) return;
        const features = fc.features ?? [];
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
  }, [target, appAt]);

  return (
    <WidgetFrame icon={ChevronRight} title="Chart">
      {data.loading ? (
        <p className="p-2 text-xs italic text-muted">Loading…</p>
      ) : data.error ? (
        <p className="p-2 text-xs text-rose-600">{data.error}</p>
      ) : (
        <ChartCanvas rows={data.rows} cfg={cfg} />
      )}
    </WidgetFrame>
  );
}

/**
 * Inner Recharts canvas. Pulls the imports off the package's
 * default surface (the package ships ESM; Next bundles it in the
 * client chunk for this widget). We keep this a separate component
 * so the import boundary lines up with where Recharts actually
 * mounts -- if the chart widget is never used on a page, the chunk
 * never loads.
 */
function ChartCanvas({
  rows,
  cfg,
}: {
  rows: Array<{ id: string | number; props: Record<string, unknown> }>;
  cfg: Extract<CustomWidget['config'], { kind: 'chart' }>;
}) {
  // Aggregate. Group rows by `groupBy` value, then apply `aggregate`
  // per bucket. 'count' is the only aggregate that doesn't need a
  // value field; everything else falls back to count if valueField
  // is missing or non-numeric (the runtime warns inline rather than
  // throwing).
  const aggregated = useMemo(() => {
    const groupBy = cfg.groupBy ?? '';
    const aggregate = cfg.aggregate ?? 'count';
    const valueField = cfg.valueField ?? '';
    const buckets = new Map<string, number[]>();
    for (const row of rows) {
      const groupRaw = groupBy ? row.props[groupBy] : '(all)';
      const groupKey =
        groupRaw === undefined || groupRaw === null ? '(missing)' : String(groupRaw);
      const valueRaw =
        aggregate === 'count' ? 1 : valueField ? row.props[valueField] : 1;
      const num =
        typeof valueRaw === 'number' && Number.isFinite(valueRaw)
          ? valueRaw
          : Number(valueRaw);
      const arr = buckets.get(groupKey) ?? [];
      if (Number.isFinite(num)) arr.push(num);
      buckets.set(groupKey, arr);
    }
    const out: Array<{ name: string; value: number }> = [];
    for (const [name, vals] of buckets) {
      if (vals.length === 0) continue;
      let value: number;
      switch (aggregate) {
        case 'count':
          value = vals.length;
          break;
        case 'sum':
          value = vals.reduce((a, b) => a + b, 0);
          break;
        case 'avg':
          value = vals.reduce((a, b) => a + b, 0) / vals.length;
          break;
        case 'min':
          value = Math.min(...vals);
          break;
        case 'max':
          value = Math.max(...vals);
          break;
        default:
          value = vals.length;
      }
      out.push({ name, value });
    }
    // Stable order: bar / pie sort by value desc; line keeps insert
    // order so a numeric x-axis renders monotonically.
    if (cfg.chartType !== 'line') out.sort((a, b) => b.value - a.value);
    return out;
  }, [rows, cfg.groupBy, cfg.aggregate, cfg.valueField, cfg.chartType]);

  if (aggregated.length === 0) {
    return (
      <p className="p-2 text-xs italic text-muted">
        No data to chart. Bind a target with at least one feature
        and pick a group-by field.
      </p>
    );
  }

  return (
    <div className="flex-1 p-2">
      <ChartPlot rows={aggregated} kind={cfg.chartType} />
    </div>
  );
}

/**
 * The actual chart. Lazy-evaluated against Recharts so the import
 * sits inside the function body where bundlers can tree-shake when
 * the runtime never reaches a chart widget. ResponsiveContainer
 * fills its parent (the WidgetFrame's flex-1 wrapper); chart-type
 * switch picks bar / line / pie.
 */
function ChartPlot({
  rows,
  kind,
}: {
  rows: Array<{ name: string; value: number }>;
  kind: 'bar' | 'line' | 'pie';
}) {
  // Imports stay top-level on the file (recharts is ESM, Next
  // bundlers handle it). The components are referenced only inside
  // this leaf so the chunk lands lazily with the chart-bearing
  // pages.
  const Recharts = ReactRecharts;

  // A small palette so pie / bar fills aren't all one color.
  // Hand-picked from Tailwind's default palette so the colors look
  // intentional next to the rest of the portal chrome.
  const palette = [
    '#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626',
    '#0891b2', '#ca8a04', '#0d9488', '#7c3aed', '#e11d48',
  ];

  if (kind === 'pie') {
    return (
      <Recharts.ResponsiveContainer width="100%" height="100%">
        <Recharts.PieChart>
          <Recharts.Pie
            data={rows}
            dataKey="value"
            nameKey="name"
            outerRadius="70%"
          >
            {rows.map((_, i) => (
              <Recharts.Cell key={i} fill={palette[i % palette.length]!} />
            ))}
          </Recharts.Pie>
          <Recharts.Tooltip />
          <Recharts.Legend />
        </Recharts.PieChart>
      </Recharts.ResponsiveContainer>
    );
  }
  if (kind === 'line') {
    return (
      <Recharts.ResponsiveContainer width="100%" height="100%">
        <Recharts.LineChart data={rows}>
          <Recharts.CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <Recharts.XAxis dataKey="name" tick={{ fontSize: 11 }} />
          <Recharts.YAxis tick={{ fontSize: 11 }} />
          <Recharts.Tooltip />
          <Recharts.Line
            type="monotone"
            dataKey="value"
            stroke={palette[0]!}
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        </Recharts.LineChart>
      </Recharts.ResponsiveContainer>
    );
  }
  // bar (default)
  return (
    <Recharts.ResponsiveContainer width="100%" height="100%">
      <Recharts.BarChart data={rows}>
        <Recharts.CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <Recharts.XAxis dataKey="name" tick={{ fontSize: 11 }} />
        <Recharts.YAxis tick={{ fontSize: 11 }} />
        <Recharts.Tooltip />
        <Recharts.Bar dataKey="value" fill={palette[0]!} />
      </Recharts.BarChart>
    </Recharts.ResponsiveContainer>
  );
}

// ---- Page-element widgets (#361) -------------------------------------------

function ImageWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'image') return null;
  const { asset, url, alt, objectFit, href, openInNewTab } = widget.config;
  // Resolve the image source. New configs use the `asset` AssetRef
  // (file-item id or external URL); legacy configs use the bare
  // `url` field. Resolution priority: asset's cachedUrl ->
  // legacy url. File-item refs whose cachedUrl is missing fall
  // through to the no-image placeholder until the runtime fetches
  // the current storageUrl (filed as follow-up; for now we rely on
  // the designer pre-warming the cache when picking).
  const resolvedUrl = resolveAssetRefSync(asset ?? null) ?? url ?? null;
  if (!resolvedUrl) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-2/40 text-xs text-muted">
        No image set
      </div>
    );
  }
  // <img> uses object-fit. Wrapper is full bleed; image fills it
  // according to the chosen fit. http(s) only is enforced by the
  // designer; if a malformed URL slips through, the browser shows
  // the broken-image icon and no script runs.
  const imgEl = (
    <img
      src={resolvedUrl}
      alt={alt ?? ''}
      className="h-full w-full"
      style={{ objectFit: objectFit ?? 'contain' }}
    />
  );
  if (href) {
    return (
      <a
        href={href}
        target={openInNewTab ? '_blank' : undefined}
        rel={openInNewTab ? 'noreferrer noopener' : undefined}
        className="block h-full w-full"
      >
        {imgEl}
      </a>
    );
  }
  return <div className="h-full w-full">{imgEl}</div>;
}

function ButtonWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'button') return null;
  const ctx = useContext(CustomMapsContext);
  const { label, variant, linkKind, url, pageId, openInNewTab } = widget.config;
  const v = variant ?? 'primary';
  const className = `inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-4 text-sm font-medium transition-colors ${
    v === 'primary'
      ? 'bg-accent text-white hover:opacity-90'
      : 'border border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
  }`;
  const text = label || 'Button';
  if ((linkKind ?? 'url') === 'page') {
    // Page-link path. Resolves to setActivePageIdx via the runtime
    // context. Renders as a plain button so middle-click / right-
    // click don't behave like an external link.
    return (
      <div className="flex h-full w-full items-center justify-center p-2">
        <button
          type="button"
          disabled={!pageId}
          onClick={() => {
            if (pageId) ctx?.navigateToPage(pageId);
          }}
          className={`${className} disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {text}
        </button>
      </div>
    );
  }
  // External-URL path. Real <a> so the browser handles middle-click,
  // right-click, copy-link, etc.
  return (
    <div className="flex h-full w-full items-center justify-center p-2">
      <a
        href={url || '#'}
        target={openInNewTab ? '_blank' : undefined}
        rel={openInNewTab ? 'noreferrer noopener' : undefined}
        aria-disabled={!url}
        onClick={(e) => {
          if (!url) e.preventDefault();
        }}
        className={className}
      >
        {text}
      </a>
    </div>
  );
}

function DividerWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'divider') return null;
  const { thicknessPx, color, style } = widget.config;
  return (
    <div className="flex h-full w-full items-center px-2">
      <hr
        className="w-full"
        style={{
          borderTop: `${thicknessPx ?? 1}px ${style ?? 'solid'} ${color ?? 'var(--color-border, #e5e7eb)'}`,
          margin: 0,
        }}
      />
    </div>
  );
}

function EmbedWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'embed') return null;
  const { url, title, strict } = widget.config;
  if (!url) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-2/40 text-xs text-muted">
        No URL set
      </div>
    );
  }
  // Sandbox flags. Default allows scripts + same-origin + popups +
  // forms (typical for embedded dashboards). Strict mode drops
  // same-origin so the embedded site can't read parent storage /
  // cookies, useful for arbitrary third-party URLs.
  const sandbox = strict
    ? 'allow-scripts allow-popups allow-forms'
    : 'allow-scripts allow-same-origin allow-popups allow-forms';
  return (
    <iframe
      src={url}
      title={title ?? url}
      sandbox={sandbox}
      className="h-full w-full border-0"
      loading="lazy"
    />
  );
}

// ---- Mapcentric quick wins (#361 part 2) -----------------------------------

function BookmarkWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'bookmark') return null;
  const ctx = useContext(CustomMapsContext);
  const { mapWidgetId, bookmarks } = widget.config;
  // Mutable in the runtime: authors capture the bound map's current
  // viewport via the "+" button. We hold these ad-hoc captures in
  // local state since the runtime doesn't have a save flow.
  // Hash + timestamp would be redundant -- the design-time list is
  // the source of truth on reload.
  const [adhoc, setAdhoc] = useState<typeof bookmarks>([]);
  const all = useMemo(() => [...bookmarks, ...adhoc], [bookmarks, adhoc]);

  function captureCurrent() {
    const map = ctx?.maps[mapWidgetId];
    if (!map) return;
    const center = map.getCenter();
    setAdhoc((cur) => [
      ...cur,
      {
        id: `bm_${Math.random().toString(36).slice(2, 8)}`,
        name: `Captured ${cur.length + 1}`,
        center: [center.lng, center.lat] as [number, number],
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      },
    ]);
  }

  function flyToBookmark(b: (typeof bookmarks)[number]) {
    const map = ctx?.maps[mapWidgetId];
    if (!map) return;
    map.flyTo({
      center: b.center,
      zoom: b.zoom,
      bearing: b.bearing ?? 0,
      pitch: b.pitch ?? 0,
      duration: 800,
    });
  }

  return (
    <WidgetFrame icon={BookmarkIcon} title="Bookmarks">
      {!mapWidgetId ? (
        <p className="p-3 text-xs text-muted">Bind a map widget.</p>
      ) : all.length === 0 && !ctx?.maps[mapWidgetId] ? (
        <p className="p-3 text-xs text-muted">No bookmarks. Map not ready.</p>
      ) : (
        <ul className="flex-1 space-y-1 overflow-auto p-2">
          {all.length === 0 ? (
            <li className="px-2 py-1 text-xs text-muted">
              No bookmarks yet. Capture the current view with the + button.
            </li>
          ) : (
            all.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => flyToBookmark(b)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink-1 transition-colors hover:bg-surface-2"
                >
                  <BookmarkIcon
                    className="h-3.5 w-3.5 text-muted"
                    strokeWidth={1.75}
                  />
                  <span className="truncate">{b.name}</span>
                  <span className="ml-auto font-mono text-[10px] text-muted">
                    z{b.zoom.toFixed(1)}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
      {ctx?.maps[mapWidgetId] && (
        <div className="border-t border-border px-2 py-1.5">
          <button
            type="button"
            onClick={captureCurrent}
            className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted hover:border-accent/40 hover:text-ink-1"
            title="Capture the bound map's current viewport"
          >
            + Add current view
          </button>
        </div>
      )}
    </WidgetFrame>
  );
}

function CoordinatesWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'coordinates') return null;
  const ctx = useContext(CustomMapsContext);
  const { mapWidgetId, format, precision, showZoom } = widget.config;
  const map = ctx?.maps[mapWidgetId] ?? null;
  const fmt = format ?? 'dd';
  const prec = precision ?? (fmt === 'dd' ? 5 : 0);
  const [pos, setPos] = useState<{ lng: number; lat: number } | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);

  useEffect(() => {
    if (!map) {
      setPos(null);
      setZoom(null);
      return;
    }
    setZoom(map.getZoom());
    const onMove = (e: maplibregl.MapMouseEvent) => {
      setPos({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    };
    const onLeave = () => setPos(null);
    const onZoomEnd = () => setZoom(map.getZoom());
    map.on('mousemove', onMove);
    map.on('mouseout', onLeave);
    map.on('zoomend', onZoomEnd);
    return () => {
      map.off('mousemove', onMove);
      map.off('mouseout', onLeave);
      map.off('zoomend', onZoomEnd);
    };
  }, [map]);

  function formatDms(deg: number, isLat: boolean): string {
    const hemi = isLat ? (deg >= 0 ? 'N' : 'S') : deg >= 0 ? 'E' : 'W';
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const minFloat = (abs - d) * 60;
    const m = Math.floor(minFloat);
    const sFloat = (minFloat - m) * 60;
    const s = sFloat.toFixed(prec);
    return `${d}° ${m}' ${s}" ${hemi}`;
  }

  const display = !map
    ? 'Bind a map widget'
    : !pos
      ? 'Move cursor over the bound map'
      : fmt === 'dms'
        ? `${formatDms(pos.lat, true)}  ${formatDms(pos.lng, false)}`
        : `${pos.lat.toFixed(prec)}, ${pos.lng.toFixed(prec)}`;

  return (
    <WidgetFrame icon={CrosshairIcon} title="Coordinates">
      <div className="flex flex-1 items-center gap-2 px-3 py-2 font-mono text-xs">
        <span className="flex-1 truncate text-ink-1">{display}</span>
        {showZoom && zoom !== null && (
          <span className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
            z {zoom.toFixed(2)}
          </span>
        )}
      </div>
    </WidgetFrame>
  );
}

function MyLocationWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'my-location') return null;
  const ctx = useContext(CustomMapsContext);
  const { mapWidgetId, zoomLevel, keepMarker } = widget.config;
  const map = ctx?.maps[mapWidgetId] ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceId = `mylocation-${widget.id}`;
  const layerId = `mylocation-layer-${widget.id}`;

  // Clean up the marker source/layer when the widget unmounts so we
  // don't leak across page switches in multi-page apps.
  useEffect(() => {
    return () => {
      if (!map) return;
      try {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
      } catch {
        /* map already torn down */
      }
    };
  }, [map, sourceId, layerId]);

  function dropMarker(lng: number, lat: number) {
    if (!map) return;
    // Add or update a single-point GeoJSON source + a styled circle
    // layer. Two sub-layers (a translucent halo + a solid dot) read
    // visually like a "current location" pin without needing a
    // sprite atlas.
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: {},
        },
      ],
    };
    const existing = map.getSource(sourceId) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (existing) {
      existing.setData(data);
    } else {
      map.addSource(sourceId, { type: 'geojson', data });
      map.addLayer({
        id: `${layerId}-halo`,
        type: 'circle',
        source: sourceId,
        paint: {
          'circle-radius': 14,
          'circle-color': '#3b82f6',
          'circle-opacity': 0.18,
          'circle-stroke-width': 0,
        },
      });
      map.addLayer({
        id: layerId,
        type: 'circle',
        source: sourceId,
        paint: {
          'circle-radius': 6,
          'circle-color': '#3b82f6',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
    }
  }

  function clearMarker() {
    if (!map) return;
    try {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getLayer(`${layerId}-halo`)) map.removeLayer(`${layerId}-halo`);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    } catch {
      /* layer already gone */
    }
  }

  function locate() {
    setError(null);
    if (!map) {
      setError('Bind a map widget.');
      return;
    }
    if (!('geolocation' in navigator)) {
      setError('Geolocation is not available in this browser.');
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBusy(false);
        const { longitude, latitude } = pos.coords;
        map.flyTo({
          center: [longitude, latitude],
          zoom: zoomLevel ?? 14,
          duration: 800,
        });
        dropMarker(longitude, latitude);
        if (!keepMarker) {
          // Remove after the fly animation settles + a short read
          // window so the user sees the pin land before it fades.
          window.setTimeout(clearMarker, 4000);
        }
      },
      (err) => {
        setBusy(false);
        setError(err.message || 'Could not get location.');
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  return (
    <WidgetFrame icon={LocateIcon} title="My Location">
      <div className="flex flex-1 flex-col items-stretch justify-center gap-1.5 p-3">
        <button
          type="button"
          onClick={locate}
          disabled={busy || !map}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <LocateIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
          {busy ? 'Locating...' : 'Show my location'}
        </button>
        {error ? (
          <p className="text-xs text-rose-600">{error}</p>
        ) : !map ? (
          <p className="text-xs text-muted">Bind a map widget to enable.</p>
        ) : null}
      </div>
    </WidgetFrame>
  );
}

// ---- Tabs container (#362) -------------------------------------------------

function TabsWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'tabs') return null;
  const tabs = widget.config.tabs;
  const [activeIdx, setActiveIdx] = useState(0);
  const safeIdx = Math.min(activeIdx, tabs.length - 1);
  const active = tabs[safeIdx];
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {tabs.length > 0 && (
        <nav
          className="flex shrink-0 items-end gap-0 overflow-x-auto border-b border-border bg-surface-1 px-2"
          aria-label="Tabs"
        >
          {tabs.map((t, i) => {
            const isActive = i === safeIdx;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveIdx(i)}
                aria-current={isActive ? 'true' : undefined}
                className={`relative px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'text-ink-0'
                    : 'text-muted hover:text-ink-1'
                }`}
              >
                {t.title}
                {isActive && (
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
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
        {active && active.widgets.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-xs text-muted">
            (Empty tab)
          </div>
        ) : (
          active &&
          active.widgets.map((c) => (
            <div
              key={c.id}
              className="overflow-hidden rounded-md border border-border bg-surface-1"
              style={{
                // Min-height proportional to the widget's intended
                // row span so a Map keeps real estate while a
                // Coordinates widget stays compact.
                minHeight: Math.max(64, c.layout.rowSpan * 24),
              }}
            >
              {renderWidget(c)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---- Themed-app containers (#22) ----------------------------------

/**
 * Render a child widget inside a container. Tool-mode children
 * render through ToolWidgetSlot (icon button + popover with the
 * widget's panel content inside) so the Search widget inside an
 * app-bar appears as a search icon button, not as a full inline
 * search input. Panel-mode children fall through to the standard
 * renderer.
 *
 * Without this dispatch, every container child rendered via
 * `renderWidget(widget)` which always picks the widget's full
 * panel UI. Result: an app-bar holding Search + Basemap +
 * AttributeTable rendered all three's full content inline,
 * blowing the bar's height and ignoring the author's tool-mode
 * config. The container thus needs to honor displayMode the same
 * way the top-level WidgetSlot does.
 */
function renderWidgetInContainer(widget: CustomWidget): React.ReactNode {
  if (isToolDisplayWidget(widget) && widgetDisplayMode(widget) === 'tool') {
    return <ToolWidgetSlot widget={widget} />;
  }
  // Suppress the inner widget's WidgetFrame header when rendered
  // inside a container. The container (foldable-group, dock-panel,
  // slideout) provides its own labeling, so the widget's
  // self-titled card chrome would double up (the screenshot showed
  // "Layers" twice: once as the foldable-group title and again as
  // the LayerList's own WidgetFrame title).
  return (
    <SuppressFrameHeaderContext.Provider value={true}>
      {renderWidget(widget)}
    </SuppressFrameHeaderContext.Provider>
  );
}

// ---- Time-slider widget (#87) ----------------------------------------------

/**
 * Time-slider widget runtime.  Drives AppTimeContext.  Authors
 * configure mode (slider vs. calendar), date bounds, and a step.
 * The widget itself is unbound (no map binding) -- every Map,
 * Chart, and AttributeTable widget on the page reads the same
 * context value, so scrubbing the slider re-fetches all of them
 * against the bitemporal source at that moment.
 *
 * Two modes:
 *   - 'date' (default): a horizontal range slider that maps a 0..N
 *     position to a date in [minDate, maxDate] at the chosen step.
 *     The slider's far-right position publishes null = "now" so a
 *     full forward scrub returns to live data.
 *   - 'calendar': a single date input.  No scrub, just snap-to-day.
 *     Clear button next to the input resets to null.
 */
function TimeSliderWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'time-slider') return null;
  const cfg = widget.config;
  const { at, setAt } = useContext(AppTimeContext);

  // Resolve the date bounds.  maxDate defaults to today; minDate
  // defaults to one year before today.  Both are local YYYY-MM-DD
  // strings the date input accepts as-is.
  const todayIso = useMemo(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }, []);
  const minDate = cfg.minDate || (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  })();
  const maxDate = cfg.maxDate || todayIso;
  const stepDays = Math.max(1, Math.floor(cfg.stepDays ?? 1));
  const label = cfg.label || 'Time';
  const mode = cfg.mode ?? 'date';

  // For the slider, convert the current `at` (ISO timestamp or null)
  // back into a YYYY-MM-DD so the slider thumb sits at the right
  // position.  Null = "now" = max position.
  const currentDateStr = at
    ? (() => {
        const d = new Date(at);
        if (isNaN(d.getTime())) return maxDate;
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      })()
    : maxDate;

  // Convert a YYYY-MM-DD picker value to the ISO `at` value we
  // publish.  Anchored at 23:59:59 local so a "March 5" pick reads
  // what the world looked like at end-of-day, matching the wizard's
  // preview convention.  If the picked date equals maxDate, we
  // publish null instead of a timestamp so the runtime drops back
  // to current truth (the most common reset action).
  function publish(yyyymmdd: string) {
    if (!yyyymmdd) {
      setAt(null);
      return;
    }
    if (yyyymmdd === maxDate) {
      setAt(null);
      return;
    }
    const d = new Date(`${yyyymmdd}T23:59:59`);
    if (isNaN(d.getTime())) {
      setAt(null);
      return;
    }
    setAt(d.toISOString());
  }

  // For the slider: compute the slider's 0..N range as days between
  // min and max, snapped to stepDays.  The slider's value is the
  // day-offset; we convert to a YYYY-MM-DD via minDate + offset.
  const minMs = new Date(`${minDate}T00:00:00`).getTime();
  const maxMs = new Date(`${maxDate}T00:00:00`).getTime();
  const totalDays = Math.max(
    0,
    Math.round((maxMs - minMs) / (24 * 60 * 60 * 1000)),
  );
  const sliderMax = Math.max(1, Math.floor(totalDays / stepDays));
  const currentMs = new Date(`${currentDateStr}T00:00:00`).getTime();
  const currentDayOffset = Math.max(
    0,
    Math.round((currentMs - minMs) / (24 * 60 * 60 * 1000)),
  );
  const sliderValue = Math.min(
    sliderMax,
    Math.max(0, Math.floor(currentDayOffset / stepDays)),
  );

  function onSliderChange(newValue: number) {
    const offsetDays = newValue * stepDays;
    const d = new Date(minMs);
    d.setDate(d.getDate() + offsetDays);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    publish(`${y}-${m}-${day}`);
  }

  return (
    <div className="flex h-full w-full items-center gap-3 rounded-md border border-border bg-surface-1 px-3 py-2 text-xs">
      <Clock className="h-4 w-4 shrink-0 text-muted" />
      <span className="shrink-0 font-medium text-ink-1">{label}:</span>
      {mode === 'calendar' ? (
        <>
          <input
            type="date"
            value={currentDateStr}
            min={minDate}
            max={maxDate}
            onChange={(e) => publish(e.target.value)}
            className="h-7 rounded-md border border-border bg-surface-0 px-2 text-xs text-ink-0 focus:border-accent focus:outline-none"
          />
          {at ? (
            <button
              type="button"
              onClick={() => setAt(null)}
              className="text-accent hover:underline"
            >
              Now
            </button>
          ) : (
            <span className="text-muted">(showing current)</span>
          )}
        </>
      ) : (
        <>
          <span className="shrink-0 tabular-nums text-muted">{minDate}</span>
          <input
            type="range"
            value={sliderValue}
            min={0}
            max={sliderMax}
            step={1}
            onChange={(e) => onSliderChange(Number(e.target.value))}
            className="flex-1 accent-accent"
            aria-label={label}
          />
          <span className="shrink-0 tabular-nums text-muted">{maxDate}</span>
          <span className="shrink-0 min-w-[5.5rem] text-right font-medium tabular-nums text-ink-0">
            {at ? currentDateStr : 'Now'}
          </span>
          {at ? (
            <button
              type="button"
              onClick={() => setAt(null)}
              className="shrink-0 text-accent hover:underline"
            >
              Reset
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Render wrappers for the themed-app container widgets. Each
 * delegates to the themed-containers.tsx component, passing the
 * tool-aware child renderer so the same widget kind renders as
 * an icon button inside an app-bar but as a full inline card
 * when placed on the page grid.
 */
function AppBarWidgetRender({ widget }: { widget: CustomWidget }) {
  // Pull itemTitle from the runtime-info context so a template that
  // didn't set its own title (the common case after we removed the
  // baked-in "Parcel Viewer" strings) falls back to the item's name.
  // Item title is the most useful identity in a portal context; the
  // app-bar's `title` slot then only needs to be set when the author
  // wants something different from the item name.
  const info = useContext(RuntimeInfoContext);
  if (widget.config.kind !== 'app-bar') return null;
  // Only spread fallbackTitle when defined; exactOptionalPropertyTypes
  // rejects explicit `undefined` for optional string props.
  const fallback = info?.itemTitle ? { fallbackTitle: info.itemTitle } : {};
  return (
    <AppBar
      config={widget.config}
      {...fallback}
      renderChild={renderWidgetInContainer}
    />
  );
}

function DockPanelWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'dock-panel') return null;
  return (
    <DockPanel config={widget.config} renderChild={renderWidgetInContainer} />
  );
}

function SlideoutWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'slideout') return null;
  return (
    <Slideout config={widget.config} renderChild={renderWidgetInContainer} />
  );
}

function FoldableGroupWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'foldable-group') return null;
  return (
    <FoldableGroup
      config={widget.config}
      renderChild={renderWidgetInContainer}
    />
  );
}

// ---- Shared frame ----------------------------------------------------------

/**
 * When true, WidgetFrame skips its own header. Used when a widget
 * is rendered inside a ToolPopover (#364) so the popover's own
 * header doesn't stack with the widget's. Defaults to false so
 * panel-mode widgets keep their existing chrome.
 */
const SuppressFrameHeaderContext = createContext<boolean>(false);

function WidgetFrame({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof MapIcon;
  title: string;
  children: React.ReactNode;
}) {
  const suppressHeader = useContext(SuppressFrameHeaderContext);
  return (
    <>
      {!suppressHeader && (
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs">
          <Icon className="h-3.5 w-3.5 text-muted" strokeWidth={1.75} />
          <span className="font-medium text-ink-0">{title}</span>
        </header>
      )}
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
  'attribute-table': TableIcon,
  text: TypeIcon,
  chart: ChevronRight,
  search: SearchIcon,
  print: Printer,
  select: MousePointer2,
  'basemap-gallery': ImageIcon,
  // #361 page-element kinds. The icons mirror the designer's
  // PALETTE_TILES so a future WidgetFrame.kindIcon defaults stay
  // consistent.
  image: ImageIcon,
  button: ChevronRight,
  divider: ChevronRight,
  embed: ChevronRight,
  // #361 part 2 mapcentric kinds.
  bookmark: BookmarkIcon,
  coordinates: CrosshairIcon,
  'my-location': LocateIcon,
  // #87 time-slider.
  'time-slider': Clock,
  // #362 layout container.
  tabs: ChevronRight,
  // Themed-app containers (#22). Icons mirror the designer's
  // PALETTE_TILES; the runtime currently renders containers via
  // their own components so this is only used as a lookup
  // fallback.
  'app-bar': SquareIcon,
  'dock-panel': SquareIcon,
  slideout: SquareIcon,
  'foldable-group': ChevronDown,
};
