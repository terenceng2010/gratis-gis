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
  Bookmark as BookmarkIcon,
  ChevronRight,
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
  Type as TypeIcon,
  X as XIcon,
} from 'lucide-react';
import Link from 'next/link';
import maplibregl from 'maplibre-gl';
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
}

export function CustomRuntimeClient({
  itemId,
  itemTitle,
  app,
  basemaps,
  baseMapData,
  widgetMapData,
  resolvedTargets,
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
              ref={runtimeContainerRef}
              className="relative grid h-full w-full"
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
  // #364: tool-mode widgets render as a small icon button in the
  // grid cell + a popover panel anchored per panelArrangement.
  // Panel-mode widgets render inline using the existing card chrome.
  const isToolMode = isToolDisplayWidget(widget) && widgetDisplayMode(widget) === 'tool';
  return (
    <section
      style={{
        gridColumn: `${widget.layout.col} / span ${widget.layout.colSpan}`,
        gridRow: `${widget.layout.row} / span ${widget.layout.rowSpan}`,
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
};

/**
 * #364: tool-mode wrapper. Renders an icon button in the canvas
 * grid cell. On click, opens a popover positioned per the widget's
 * panelArrangement, using the existing widget renderer for content.
 */
function ToolWidgetSlot({ widget }: { widget: CustomWidget }) {
  const ctx = useContext(CustomMapsContext);
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICON[widget.kind] ?? SquareIcon;
  const label = KIND_TOOL_LABEL[widget.kind] ?? widget.kind;
  const arrangement = widgetPanelArrangement(widget);

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
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-pressed={open}
        title={label}
        className={`group/tool flex h-full w-full flex-col items-center justify-center gap-0.5 rounded-md border bg-surface-1 shadow-sm transition-all ${
          open
            ? 'border-ink-0 text-ink-0 ring-2 ring-ink-0/10'
            : 'border-border text-ink-1 hover:-translate-y-0.5 hover:border-ink-1 hover:shadow-md'
        }`}
      >
        <Icon
          className={`h-5 w-5 transition-transform ${
            open ? 'scale-110' : 'group-hover/tool:scale-105'
          }`}
          strokeWidth={1.75}
        />
        <span className="text-[10px] font-medium leading-none">{label}</span>
      </button>
      {open && ctx && (
        <ToolPopover
          arrangement={arrangement}
          containerRef={ctx.runtimeContainerRef}
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
  title,
  icon: Icon,
  onClose,
  children,
}: {
  arrangement: PanelArrangement;
  containerRef: RefObject<HTMLDivElement>;
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
  const positionStyle = computePopoverPosition({
    anchor,
    width,
    height,
    offsetX,
    offsetY,
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

  // Floating: portal-style. The container ref might not yet be
  // mounted; in that case we render relative to the document body
  // as a fallback, which gives the same visual outcome on a
  // single-pane runtime layout.
  const container = containerRef.current ?? null;
  if (!container) return null;

  return (
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
    </>
  );
}

function ToolPopoverHeader({
  title,
  icon: Icon,
  onClose,
}: {
  title: string;
  icon: typeof MapIcon;
  onClose: () => void;
}) {
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-3 py-2">
      <Icon className="h-4 w-4 text-muted" strokeWidth={1.75} />
      <span className="flex-1 truncate text-sm font-semibold text-ink-0">
        {title}
      </span>
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
 * Translate a 9-cell anchor + offset into CSS positioning rules.
 * Each anchor corresponds to a corner / edge of the parent.
 * Offsets nudge inward (positive value moves the panel away from
 * the anchored edge).
 */
function computePopoverPosition({
  anchor,
  offsetX,
  offsetY,
}: {
  anchor: PanelAnchor;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}): React.CSSProperties {
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
      return <ChartWidgetRender />;
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
    case 'tabs':
      return <TabsWidgetRender widget={widget} />;
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
        // #361 part 2: surface the live MapLibre Map up to the
        // runtime context so sibling widgets (Coordinates, Bookmark,
        // MyLocation) can subscribe to events / addSource / flyTo
        // imperatively without prop-drilling.
        onMapReady={(map) => ctx.registerMap(widget.id, map)}
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

// ---- Page-element widgets (#361) -------------------------------------------

function ImageWidgetRender({ widget }: { widget: CustomWidget }) {
  if (widget.config.kind !== 'image') return null;
  const { url, alt, objectFit, href, openInNewTab } = widget.config;
  if (!url) {
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
      src={url}
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
  'attribute-table': LayersIcon,
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
  // #362 layout container.
  tabs: ChevronRight,
};
