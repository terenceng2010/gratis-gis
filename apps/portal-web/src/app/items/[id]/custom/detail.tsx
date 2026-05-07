'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Code as CodeIcon,
  ExternalLink,
  Eye,
  Image as ImageIcon,
  Layers as LayersIcon,
  ListTree,
  Loader2,
  Map as MapIcon,
  Minus as MinusIcon,
  MoreVertical,
  MousePointer2,
  MousePointerClick,
  Pencil,
  Plus,
  Printer,
  Search,
  Settings,
  Sparkles,
  Square,
  Table2,
  Trash2,
  Type as TypeIcon,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  BasemapData,
  CustomAppData,
  CustomLayout,
  CustomPage,
  CustomWidget,
  CustomWidgetKind,
  Item,
  MapData,
  ViewerTarget,
  WebAppData,
} from '@gratis-gis/shared-types';
import { DEFAULT_MAP, migrateCustomAppData } from '@gratis-gis/shared-types';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { MapCanvas } from '../map/map-canvas';
import { PickMapDialog } from '../editor/pick-map-dialog';

interface Props {
  itemId: string;
  initial: CustomAppData;
  canEdit: boolean;
}

/**
 * Custom Web App designer (#261 / #337). Three-pane layout:
 *
 *   - LEFT rail: widget palette (drag tiles onto the canvas) plus
 *     a pages list at the bottom.
 *   - CENTER: 12-column grid canvas. Widgets render as styled
 *     placeholder cards with their bound config summarized; click
 *     to select. (Live Map preview lands in Slice 7.)
 *   - RIGHT rail: properties panel. With nothing selected, shows
 *     app + page-level settings (default map, targets, page title).
 *     With a widget selected, swaps to that widget's layout +
 *     per-kind config (Slice 3).
 *
 * Drag-drop placement uses native HTML5 DnD with an "x-widget-kind"
 * MIME type the canvas reads on drop, mirroring the form designer's
 * "x-question-type" idiom so authors who learned the form designer
 * find this one familiar (#337). Reposition + resize land in #338;
 * for now the right-rail properties panel exposes col / row /
 * colSpan / rowSpan as numeric inputs as a transitional UX.
 *
 * Render fidelity: Slice 1 ships with placeholder widget cards.
 * Slice 7 (#343) swaps in a real (small) MapLibre instance for the
 * Map widget so the canvas matches what the runtime renders. For
 * everything else, real renders are reserved for the runtime
 * (#341); the designer's job is layout + binding.
 */
export function CustomAppDetail({ itemId, initial, canEdit }: Props) {
  // #357: migrate any v1 (12-col / 48px-row) app to the new v2 grid
  // (24-col / 24px-row) on load so the rest of the designer can
  // assume v2 coordinates. Idempotent: v2 input passes through
  // unchanged. The migrated app is dirty-on-first-save which is
  // intentional (a single re-save persists the v2 layout).
  const [app, setApp] = useState<CustomAppData>(() =>
    migrateCustomAppData(initial),
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The PickMapDialog is reused for both the app-default map and the
  // per-Map-widget override (#357 follow-up). Tagged scope lets one
  // dialog instance write to the right slot.
  const [pickingMap, setPickingMap] = useState<
    null | { scope: 'app' } | { scope: 'widget'; widgetId: string }
  >(null);
  // Multi-page support (#342). The home page is always pages[0]; if
  // the user deletes pages or reorders, activePageIdx clamps. Per-
  // page selection is reset on page switch so the right rail doesn't
  // try to render properties for a widget that lives on another page.
  const [activePageIdx, setActivePageIdxRaw] = useState(0);
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);
  const setActivePageIdx = useCallback((idx: number) => {
    setActivePageIdxRaw(idx);
    setSelectedWidgetId(null);
  }, []);

  // Resolved referenced map title (optional). Same lazy-fetch as the
  // previous detail page.
  const [mapTitle, setMapTitle] = useState<string | null>(null);
  // Preview-time MapData composed from the referenced map (basemap +
  // viewport + non-target layers), feeding the live MapLibre preview
  // in Map widgets on the canvas (#343). Targets are intentionally
  // not resolved here -- the runtime does the per-target geojson
  // fetch; the designer just needs a "this is what your map will
  // look like" frame.
  const [previewMapData, setPreviewMapData] = useState<MapData | null>(null);
  // Org's basemap library, resolved into the CustomBasemap shape
  // MapCanvas consumes. Stays empty until the fetch completes; the
  // preview falls back to MapCanvas's inline OSM raster style in
  // that interim window.
  const [previewBasemaps, setPreviewBasemaps] = useState<CustomBasemap[]>([]);
  // #363: per-Map-widget MapData when the widget has its own
  // config.mapId override. Without this the canvas preview shows
  // the app default for EVERY map widget, ignoring overrides.
  const [widgetMapData, setWidgetMapData] = useState<
    Record<string, MapData>
  >({});
  // Resolved titles for widget-level map overrides, keyed by mapId
  // (not widget id) so two Map widgets pointing at the same map
  // share one entry. Used by MapWidgetConfig so the source field
  // shows the map's title instead of a truncated UUID.
  const [mapTitlesById, setMapTitlesById] = useState<
    Record<string, string>
  >({});
  // Stable join of every Map widget's id+mapId so the effect
  // re-runs only when the override-set actually changes (not on
  // every render or on unrelated widget edits).
  const widgetMapIdsKey = useMemo(() => {
    const pairs: string[] = [];
    for (const p of app.pages) {
      for (const w of p.widgets) {
        if (w.kind === 'map' && w.config.kind === 'map' && w.config.mapId) {
          pairs.push(`${w.id}:${w.config.mapId}`);
        }
      }
    }
    return pairs.sort().join('|');
  }, [app.pages]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Collect unique map ids: app default + every widget
        // override. A Set keeps duplicates from re-fetching.
        const uniqueMapIds = new Set<string>();
        if (app.mapId) uniqueMapIds.add(app.mapId);
        for (const p of app.pages) {
          for (const w of p.widgets) {
            if (
              w.kind === 'map' &&
              w.config.kind === 'map' &&
              w.config.mapId
            ) {
              uniqueMapIds.add(w.config.mapId);
            }
          }
        }
        const [mapsRes, ...mapResponses] = await Promise.all([
          fetch('/api/portal/items?type=basemap'),
          ...Array.from(uniqueMapIds).map((id) =>
            fetch(`/api/portal/items/${id}`),
          ),
        ]);
        if (cancelled) return;
        if (mapsRes.ok) {
          const items = (await mapsRes.json()) as Array<Item<BasemapData>>;
          const built = items
            .map(basemapItemToCustomBasemap)
            .filter((b): b is CustomBasemap => b !== null);
          if (!cancelled) setPreviewBasemaps(built);
        }
        const dataById = new Map<string, { data: MapData; title: string }>();
        for (const res of mapResponses) {
          if (!res.ok) continue;
          const item = (await res.json()) as Item<MapData>;
          if (item.data) {
            dataById.set(item.id, { data: item.data, title: item.title });
          }
        }
        if (cancelled) return;
        // App-default first.
        if (app.mapId && dataById.has(app.mapId)) {
          const entry = dataById.get(app.mapId)!;
          setMapTitle(entry.title);
          setPreviewMapData(entry.data);
        } else {
          setMapTitle(null);
          setPreviewMapData(null);
        }
        // Per-widget override map.
        const widgetMap: Record<string, MapData> = {};
        for (const p of app.pages) {
          for (const w of p.widgets) {
            if (
              w.kind === 'map' &&
              w.config.kind === 'map' &&
              w.config.mapId &&
              dataById.has(w.config.mapId)
            ) {
              widgetMap[w.id] = dataById.get(w.config.mapId)!.data;
            }
          }
        }
        setWidgetMapData(widgetMap);
        // Title-by-id surface so MapWidgetConfig can render the map
        // title instead of the raw UUID. Includes the app default's
        // entry too so a single lookup works for both scopes.
        const titles: Record<string, string> = {};
        for (const [id, entry] of dataById.entries()) {
          titles[id] = entry.title;
        }
        setMapTitlesById(titles);
      } catch {
        /* silent: preview fall through to default basemap */
      }
    })();
    return () => {
      cancelled = true;
    };
    // widgetMapIdsKey covers every widget-level mapId change; app.mapId
    // for the app-default change. Both are needed because the effect
    // also reacts to mapId-only changes on the same widget set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.mapId, widgetMapIdsKey]);

  const onSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const data: WebAppData = {
        version: 1,
        template: 'custom',
        config: { template: 'custom', custom: app },
      };
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`save failed: ${res.status} ${txt}`);
      }
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }, [app, itemId]);

  const updateApp = useCallback((patch: Partial<CustomAppData>) => {
    setApp((cur) => ({ ...cur, ...patch }));
    setDirty(true);
  }, []);

  const updatePage = useCallback(
    (idx: number, patch: Partial<CustomPage>) => {
      setApp((cur) => ({
        ...cur,
        pages: cur.pages.map((p, i) => (i === idx ? { ...p, ...patch } : p)),
      }));
      setDirty(true);
    },
    [],
  );

  const updateWidget = useCallback(
    (widgetId: string, patch: Partial<CustomWidget>) => {
      setApp((cur) => ({
        ...cur,
        pages: cur.pages.map((p, i) =>
          i !== activePageIdx
            ? p
            : {
                ...p,
                widgets: p.widgets.map((w) =>
                  w.id === widgetId ? ({ ...w, ...patch } as CustomWidget) : w,
                ),
              },
        ),
      }));
      setDirty(true);
    },
    [activePageIdx],
  );

  const removeWidget = useCallback(
    (widgetId: string) => {
      setApp((cur) => ({
        ...cur,
        pages: cur.pages.map((p, i) =>
          i !== activePageIdx
            ? p
            : { ...p, widgets: p.widgets.filter((w) => w.id !== widgetId) },
        ),
      }));
      setSelectedWidgetId(null);
      setDirty(true);
    },
    [activePageIdx],
  );

  const addWidgetAt = useCallback(
    (kind: CustomWidgetKind, col: number, row: number) => {
      const layout: CustomLayout = {
        ...defaultLayoutForKind(kind),
        col: clampCol(col),
        row: Math.max(1, Math.round(row)),
      };
      const widget = stampWidget(kind, layout);
      setApp((cur) => {
        // #339: auto-bind a newly-dropped map-following widget to
        // the only Map widget already on the page. Saves the user
        // a manual mapWidgetId pick in the common case (one Map on
        // the canvas + a Legend / LayerList / Search / Print /
        // Select / BasemapGallery dropped alongside it). When there
        // are zero or multiple Map widgets we leave mapWidgetId
        // unset; the user picks via the properties panel.
        const page = cur.pages[activePageIdx];
        const onlyMap =
          page && page.widgets.filter((w) => w.kind === 'map').length === 1
            ? page.widgets.find((w) => w.kind === 'map')
            : null;
        const widgetWithBinding =
          onlyMap && WIDGETS_BIND_MAP_ID.has(widget.kind)
            ? autoBindMapWidgetId(widget, onlyMap.id)
            : widget;
        return {
          ...cur,
          pages: cur.pages.map((p, i) =>
            i !== activePageIdx
              ? p
              : { ...p, widgets: [...p.widgets, widgetWithBinding] },
          ),
        };
      });
      setSelectedWidgetId(widget.id);
      setDirty(true);
    },
    [activePageIdx],
  );

  // ---- Page CRUD (#342) -----------------------------------------------------

  const addPage = useCallback(() => {
    setApp((cur) => {
      const usedTitles = new Set(cur.pages.map((p) => p.title));
      let n = cur.pages.length + 1;
      let title = `Page ${n}`;
      while (usedTitles.has(title)) {
        n += 1;
        title = `Page ${n}`;
      }
      const newPage: CustomPage = {
        id: `page-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
        title,
        widgets: [],
      };
      return { ...cur, pages: [...cur.pages, newPage] };
    });
    setDirty(true);
    // Switch to the freshly added page so the user can start dropping
    // widgets onto it without an extra click. The new page lands at
    // index `app.pages.length` (current length, before this update).
    setActivePageIdx(app.pages.length);
  }, [app.pages.length, setActivePageIdx]);

  const renamePage = useCallback((idx: number, title: string) => {
    setApp((cur) => ({
      ...cur,
      pages: cur.pages.map((p, i) => (i === idx ? { ...p, title } : p)),
    }));
    setDirty(true);
  }, []);

  const removePage = useCallback(
    (idx: number) => {
      setApp((cur) => {
        if (cur.pages.length <= 1) return cur; // home page is sticky
        return { ...cur, pages: cur.pages.filter((_, i) => i !== idx) };
      });
      setDirty(true);
      // Re-clamp active page index after the removal. If the active
      // page was the removed one, fall back to the previous page.
      setActivePageIdxRaw((cur) => {
        if (cur < idx) return cur;
        if (cur === idx) return Math.max(0, idx - 1);
        return cur - 1;
      });
      setSelectedWidgetId(null);
    },
    [],
  );

  const movePage = useCallback(
    (from: number, to: number) => {
      setApp((cur) => {
        if (from === to || from < 0 || to < 0) return cur;
        if (from >= cur.pages.length || to >= cur.pages.length) return cur;
        const next = cur.pages.slice();
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved!);
        return { ...cur, pages: next };
      });
      setDirty(true);
      // Keep the active page following its widget set across the move.
      setActivePageIdxRaw((cur) => {
        if (cur === from) return to;
        if (from < cur && cur <= to) return cur - 1;
        if (to <= cur && cur < from) return cur + 1;
        return cur;
      });
    },
    [],
  );

  const activePage = app.pages[activePageIdx] ?? app.pages[0]!;
  const selectedWidget =
    activePage.widgets.find((w) => w.id === selectedWidgetId) ?? null;

  return (
    <div className="space-y-3">
      {/* Header card: status + Save + Open ------------------------------ */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3">
        <div className="flex items-center gap-3">
          <Sparkles className="h-4 w-4 text-amber-500" strokeWidth={1.75} />
          <div>
            <div className="text-sm font-medium text-ink-0">
              Custom web app
            </div>
            <div className="text-xs text-muted">
              {app.pages.length} page{app.pages.length === 1 ? '' : 's'} ·{' '}
              {activePage.widgets.length} widget
              {activePage.widgets.length === 1 ? '' : 's'} on this page
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="text-xs font-medium text-emerald-600">Saved</span>
          )}
          {error && (
            <span className="inline-flex items-center gap-1 text-xs text-rose-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              {error}
            </span>
          )}
          <button
            type="button"
            disabled={!canEdit || !dirty || saving}
            onClick={onSave}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </button>
          <a
            href={`/items/${itemId}/custom/run`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs font-semibold text-ink-1 hover:bg-surface-2"
          >
            <Eye className="h-3.5 w-3.5" />
            Open
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      {/* Three-pane workspace --------------------------------------- */}
      <div className="flex h-[calc(100vh-180px)] min-h-[480px] gap-3">
        {/* LEFT: palette */}
        <Palette canEdit={canEdit} />

        {/* CENTER: page tabs + canvas. The tab strip lives just above
            the canvas so it stays aligned with the grid. The runtime
            uses the same strip in its header. */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <PageTabs
            pages={app.pages}
            activeIdx={activePageIdx}
            canEdit={canEdit}
            onSelect={setActivePageIdx}
            onAdd={addPage}
            onRename={renamePage}
            onRemove={removePage}
            onMove={movePage}
          />
          <Canvas
            widgets={activePage.widgets}
            selectedId={selectedWidgetId}
            canEdit={canEdit}
            previewMapData={previewMapData}
            previewBasemaps={previewBasemaps}
            widgetMapData={widgetMapData}
            onSelect={setSelectedWidgetId}
            onCanvasDrop={(kind, col, row) => addWidgetAt(kind, col, row)}
            onWidgetLayout={(id, layout) => updateWidget(id, { layout })}
          />
        </div>

        {/* RIGHT: properties panel */}
        <aside className="flex w-72 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-surface-1">
          {selectedWidget ? (
            <WidgetProperties
              widget={selectedWidget}
              canEdit={canEdit}
              pageWidgets={activePage.widgets}
              appPages={app.pages}
              appTargets={app.targets}
              appMapId={app.mapId}
              appMapTitle={mapTitle}
              mapTitlesById={mapTitlesById}
              onChange={(patch) => updateWidget(selectedWidget.id, patch)}
              onChangeConfig={(configPatch) =>
                updateWidget(selectedWidget.id, {
                  config: {
                    ...selectedWidget.config,
                    ...configPatch,
                  } as CustomWidget['config'],
                })
              }
              onPickWidgetMap={() =>
                setPickingMap({ scope: 'widget', widgetId: selectedWidget.id })
              }
              onRemove={() => removeWidget(selectedWidget.id)}
            />
          ) : (
            <AppProperties
              app={app}
              page={activePage}
              mapTitle={mapTitle}
              canEdit={canEdit}
              onUpdateApp={updateApp}
              onUpdatePage={(patch) => updatePage(activePageIdx, patch)}
              onClearMap={() => {
                setApp((cur) => {
                  const { mapId: _drop, ...rest } = cur;
                  void _drop;
                  return rest;
                });
                setDirty(true);
              }}
              onPickMap={() => setPickingMap({ scope: 'app' })}
            />
          )}
        </aside>
      </div>

      <PickMapDialog
        open={pickingMap !== null}
        onPick={(picked) => {
          if (pickingMap?.scope === 'widget') {
            // Per-widget override path: write to widget.config.mapId.
            const wid = pickingMap.widgetId;
            const widget = activePage.widgets.find((w) => w.id === wid);
            if (widget && widget.kind === 'map') {
              updateWidget(wid, {
                config: {
                  ...widget.config,
                  mapId: picked.id,
                } as CustomWidget['config'],
              });
            }
          } else {
            // App-default path (or null fallthrough): write to app.mapId.
            updateApp({ mapId: picked.id });
          }
          setPickingMap(null);
        }}
        onClose={() => setPickingMap(null)}
      />
    </div>
  );
}

// ---- Live Map preview helpers (#343) ---------------------------------------

/**
 * Map a basemap item into the CustomBasemap shape MapCanvas consumes.
 * Mirrors the same helper that lives in run/page.tsx (and survey +
 * viewer); kept duplicated for now because the four call sites read
 * from different fetch shapes (server-side vs. client-side). Promote
 * to a shared util when a fifth caller appears.
 */
function basemapItemToCustomBasemap(
  it: Item<BasemapData>,
): CustomBasemap | null {
  const d = it.data ?? ({} as BasemapData);
  let url: string | undefined;
  let sourceKind: CustomBasemap['sourceKind'];
  let config: Record<string, unknown> | null = null;
  switch (d.kind) {
    case 'style-url':
      if (!d.styleUrl) return null;
      url = d.styleUrl;
      sourceKind = 'vector-style';
      break;
    case 'tile-url':
      if (!d.tileUrl) return null;
      url = d.tileUrl;
      sourceKind = 'xyz';
      break;
    case 'wms':
      if (!d.wmsUrl) return null;
      url = d.wmsUrl;
      sourceKind = 'wms';
      config = (d.wmsConfig ?? null) as Record<string, unknown> | null;
      break;
    default:
      return null;
  }
  return {
    id: it.id,
    orgId: it.orgId,
    label: it.title,
    description: it.description ?? '',
    url,
    sourceKind,
    attribution: d.attribution ?? '',
    thumbnailUrl: d.thumbnailUrl ?? it.thumbnailUrl ?? null,
    config,
    isDefault: false,
  };
}

/**
 * Tiny read-only MapLibre preview tile shown inside a Map widget on
 * the designer canvas. Mirrors what the runtime renders for that
 * widget but with all interaction suppressed -- the user is editing
 * layout, not exploring the map. Camera state lives in local
 * useState so MapCanvas's onCameraChange has somewhere to land
 * without bubbling back up into CustomAppData.
 *
 * Frozen during a gesture to avoid MapLibre re-rendering on every
 * mousemove tick; we render a static placeholder so the drag stays
 * smooth.
 */
function MapWidgetPreview({
  baseMapData,
  basemaps,
  frozen,
}: {
  baseMapData: MapData | null;
  basemaps: CustomBasemap[];
  frozen: boolean;
}) {
  // MapCanvas mutates camera through the controlled prop; we hold
  // it locally so panning + zooming inside the preview tile stays
  // contained.
  const [previewMap, setPreviewMap] = useState<MapData | null>(baseMapData);
  useEffect(() => {
    setPreviewMap(baseMapData);
  }, [baseMapData]);
  if (!previewMap) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-2/40 text-xs text-muted">
        Pick a Map in the right rail to preview
      </div>
    );
  }
  if (frozen) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-2/40 text-xs text-muted">
        Resizing...
      </div>
    );
  }
  return (
    <div className="pointer-events-none h-full w-full">
      <MapCanvas
        map={previewMap}
        basemaps={basemaps}
        selection={EMPTY_SELECTION}
        selectTool="off"
        suppressPopup
        hideNavigationControl
        onCameraChange={(c) => setPreviewMap((cur) => (cur ? { ...cur, ...c } : cur))}
        onSelectionChange={() => {}}
      />
    </div>
  );
}

const EMPTY_SELECTION: Record<string, Set<number | string>> = {};

// ---- Palette ---------------------------------------------------------------

/**
 * Widget categories. Mirrors Experience Builder's six-bucket
 * taxonomy (Mapcentric, Datacentric, Page element, Menu and tool,
 * Layout, Section) but trimmed to the three buckets we have today.
 * Future widgets (#361) drop into the existing buckets or grow new
 * ones (Layout when Row / Column / Grid land).
 *
 * `map` here means "binds to or feeds a Map widget" (basemap, layer
 * toggles, search, print, etc.). `data` means "reads from an app
 * target" (Attribute Table, Chart). `page` is static layout content
 * (Text today; Image / Button / Divider / Embed land in #361).
 */
type PaletteCategory = 'map' | 'data' | 'page';

const PALETTE_CATEGORIES: Array<{
  id: PaletteCategory;
  label: string;
  hint: string;
}> = [
  {
    id: 'map',
    label: 'Map widgets',
    hint: 'Drive or follow a map',
  },
  {
    id: 'data',
    label: 'Data widgets',
    hint: 'Read from an app target',
  },
  {
    id: 'page',
    label: 'Page elements',
    hint: 'Static layout content',
  },
];

const PALETTE_TILES: Array<{
  kind: CustomWidgetKind;
  label: string;
  Icon: LucideIcon;
  hint: string;
  category: PaletteCategory;
}> = [
  // -- Map widgets -----------------------------------------------
  {
    kind: 'map',
    label: 'Map',
    Icon: MapIcon,
    hint: 'The main map canvas',
    category: 'map',
  },
  {
    kind: 'layer-list',
    label: 'Layers',
    Icon: LayersIcon,
    hint: 'Layer toggles + ordering for a map',
    category: 'map',
  },
  {
    kind: 'legend',
    label: 'Legend',
    Icon: ListTree,
    hint: 'Symbology of visible layers',
    category: 'map',
  },
  {
    kind: 'basemap-gallery',
    label: 'Basemaps',
    Icon: ImageIcon,
    hint: 'Tile grid to switch basemaps on a map',
    category: 'map',
  },
  {
    kind: 'print',
    label: 'Print',
    Icon: Printer,
    hint: 'Print the bound map',
    category: 'map',
  },
  // -- Data widgets ----------------------------------------------
  {
    kind: 'search',
    label: 'Search',
    Icon: Search,
    hint: 'Address + attribute search bar',
    category: 'data',
  },
  {
    kind: 'select',
    label: 'Select',
    Icon: MousePointer2,
    hint: 'Selection-mode buttons (click / box / lasso)',
    category: 'data',
  },
  {
    kind: 'attribute-table',
    label: 'Attribute Table',
    Icon: Table2,
    hint: 'Rows from one of the app targets',
    category: 'data',
  },
  {
    kind: 'chart',
    label: 'Chart',
    Icon: BarChart3,
    hint: 'Bar / line / pie over a target',
    category: 'data',
  },
  // -- Page elements ---------------------------------------------
  {
    kind: 'text',
    label: 'Text',
    Icon: TypeIcon,
    hint: 'Headings, intros, attributions',
    category: 'page',
  },
  {
    kind: 'image',
    label: 'Image',
    Icon: ImageIcon,
    hint: 'Static image from a URL',
    category: 'page',
  },
  {
    kind: 'button',
    label: 'Button',
    Icon: MousePointerClick,
    hint: 'Link to another page or external URL',
    category: 'page',
  },
  {
    kind: 'divider',
    label: 'Divider',
    Icon: MinusIcon,
    hint: 'Horizontal rule between sections',
    category: 'page',
  },
  {
    kind: 'embed',
    label: 'Embed',
    Icon: CodeIcon,
    hint: 'iframe a video, dashboard, or form',
    category: 'page',
  },
];

function Palette({ canEdit }: { canEdit: boolean }) {
  // Bucket once at module scope so we don't refilter every render.
  // Each category renders as its own subsection with a small header
  // so authors can scan by purpose ("I need a thing that talks to
  // the map" vs. "I need a static text block").
  const grouped = PALETTE_CATEGORIES.map((cat) => ({
    ...cat,
    tiles: PALETTE_TILES.filter((t) => t.category === cat.id),
  })).filter((g) => g.tiles.length > 0);

  return (
    <aside className="flex w-56 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-surface-1">
      <div className="border-b border-border px-3 py-2.5">
        <p className="text-sm font-medium text-ink-0">Widgets</p>
        <p className="mt-0.5 text-xs text-muted">
          {canEdit ? 'Drag onto the canvas' : 'Read only'}
        </p>
      </div>
      <div className="flex flex-col overflow-auto pb-2">
        {grouped.map((group) => (
          <div key={group.id} className="border-b border-border last:border-0">
            <div className="px-3 pb-1 pt-3">
              <p className="text-xs font-medium text-ink-1">{group.label}</p>
            </div>
            <div className="flex flex-col">
              {group.tiles.map((tile) => (
                <PaletteTile key={tile.kind} {...tile} canEdit={canEdit} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function PaletteTile({
  kind,
  label,
  Icon,
  hint,
  canEdit,
}: {
  kind: CustomWidgetKind;
  label: string;
  Icon: LucideIcon;
  hint: string;
  canEdit: boolean;
}) {
  return (
    <button
      type="button"
      draggable={canEdit}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/x-widget-kind', kind);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      title={hint}
      disabled={!canEdit}
      className="group flex w-full cursor-grab items-center gap-2.5 px-3 py-2 text-left text-sm text-ink-1 transition-colors hover:bg-surface-2 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Icon className="h-4 w-4 shrink-0 text-muted group-hover:text-ink-1" strokeWidth={1.75} />
      <span className="truncate">{label}</span>
    </button>
  );
}

// ---- PageTabs (#342) -------------------------------------------------------

/**
 * Horizontal tab strip above the canvas. One tab per page; click to
 * switch. The active tab gets inline rename + delete + reorder
 * affordances. Adding a page is a "+" button at the end.
 *
 * Single-page mode: tabs strip still renders so the user discovers
 * the affordance, but there's nothing to delete and reorder is a
 * no-op.
 *
 * Drag-to-reorder is deferred; for now reorder is left/right arrow
 * buttons on the active tab (matches the form designer's question
 * reorder UX).
 */
function PageTabs({
  pages,
  activeIdx,
  canEdit,
  onSelect,
  onAdd,
  onRename,
  onRemove,
  onMove,
}: {
  pages: CustomPage[];
  activeIdx: number;
  canEdit: boolean;
  onSelect: (idx: number) => void;
  onAdd: () => void;
  onRename: (idx: number, title: string) => void;
  onRemove: (idx: number) => void;
  onMove: (from: number, to: number) => void;
}) {
  const [renamingIdx, setRenamingIdx] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  function commitRename() {
    if (renamingIdx === null) return;
    const trimmed = renameDraft.trim();
    if (trimmed.length > 0 && trimmed !== pages[renamingIdx]!.title) {
      onRename(renamingIdx, trimmed);
    }
    setRenamingIdx(null);
    setRenameDraft('');
  }

  return (
    <div className="flex shrink-0 items-end gap-0 overflow-x-auto border-b border-border bg-surface-1 px-2">
      {pages.map((p, i) => {
        const isActive = i === activeIdx;
        const isRenaming = renamingIdx === i;
        return (
          <div
            key={p.id}
            className={`group relative flex items-center gap-1 px-3 py-2 text-sm transition-colors ${
              isActive
                ? 'text-ink-0'
                : 'text-muted hover:text-ink-1'
            }`}
          >
            {isRenaming ? (
              <input
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setRenamingIdx(null);
                    setRenameDraft('');
                  }
                }}
                className="w-32 border-none bg-transparent p-0 text-sm font-medium text-ink-0 focus:outline-none focus:ring-0"
              />
            ) : (
              <button
                type="button"
                onClick={() => onSelect(i)}
                onDoubleClick={() => {
                  if (!canEdit) return;
                  setRenamingIdx(i);
                  setRenameDraft(p.title);
                }}
                title={canEdit ? 'Click to switch, double-click to rename' : ''}
                className="font-medium"
              >
                {p.title}
              </button>
            )}
            {isActive && canEdit && !isRenaming && (
              <span className="inline-flex items-center gap-0 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  title="Move left"
                  disabled={i === 0}
                  onClick={() => onMove(i, i - 1)}
                  className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-ink-1 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  title="Move right"
                  disabled={i === pages.length - 1}
                  onClick={() => onMove(i, i + 1)}
                  className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-ink-1 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  title="Rename"
                  onClick={() => {
                    setRenamingIdx(i);
                    setRenameDraft(p.title);
                  }}
                  className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-ink-1"
                >
                  <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  title={
                    pages.length === 1
                      ? 'A custom app must have at least one page.'
                      : p.widgets.length > 0
                        ? `Delete page (${p.widgets.length} widget${p.widgets.length === 1 ? '' : 's'} on it)`
                        : 'Delete page'
                  }
                  disabled={pages.length === 1}
                  onClick={() => {
                    if (pages.length === 1) return;
                    if (
                      p.widgets.length > 0 &&
                      !confirm(
                        `Delete "${p.title}" and its ${p.widgets.length} widget${p.widgets.length === 1 ? '' : 's'}? This cannot be undone.`,
                      )
                    ) {
                      return;
                    }
                    onRemove(i);
                  }}
                  className="rounded p-0.5 text-muted hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              </span>
            )}
            {/* Active-tab underline. -bottom-px aligns it with the
                wrapper's border-b so the indicator visually replaces
                the divider for the active tab. */}
            {isActive && (
              <span
                aria-hidden
                className="pointer-events-none absolute -bottom-px left-2 right-2 h-0.5 rounded-full bg-ink-0"
              />
            )}
          </div>
        );
      })}
      {canEdit && (
        <button
          type="button"
          onClick={onAdd}
          title="Add page"
          className="ml-1 inline-flex items-center gap-1 px-2 py-2 text-sm text-muted transition-colors hover:text-ink-1"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          Page
        </button>
      )}
    </div>
  );
}

// ---- Canvas -----------------------------------------------------------------

// #357: doubled grid resolution. The schema bumped from version 1 to
// 2 (12-col + 48px row -> 24-col + 24px row) for finer drag/snap.
// Existing apps are migrated on load via migrateCustomAppData.
const ROW_HEIGHT_PX = 24;
const GRID_COLS = 24;
/**
 * Floor for the canvas's working width. On viewports narrower than
 * this the canvas pane scrolls horizontally instead of squeezing the
 * 24-column grid into a sliver. Sized so each column gets ~50px,
 * which is the floor below which Map / AttributeTable widgets start
 * to look unusable in a real layout.
 */
const CANVAS_MIN_WIDTH_PX = 1200;

/**
 * Active drag-or-resize gesture state. The canvas owns one of these
 * at a time (or null) -- one global gesture is enough since both
 * resize and reposition live on the same selected widget.
 *
 *   - kind 'move': the widget body is being dragged. mousemove
 *     updates col + row on the snap grid; mouseup commits the
 *     final layout.
 *   - kind 'resize-br' / 'resize-r' / 'resize-b': the user
 *     mouse-downed on a corner / edge handle. The corresponding
 *     dimension(s) update on mousemove.
 *
 * Drag threshold: gesture has to move >= 4px before we mutate
 * layout. That keeps a plain click from accidentally bumping
 * a widget by 0,0 (which still triggers a save dirty bit and
 * looks confusing in the UI).
 */
interface ActiveGesture {
  kind: 'move' | 'resize-br' | 'resize-r' | 'resize-b';
  widgetId: string;
  startX: number;
  startY: number;
  startLayout: CustomLayout;
}

const DRAG_THRESHOLD_PX = 4;

function Canvas({
  widgets,
  selectedId,
  canEdit,
  previewMapData,
  previewBasemaps,
  widgetMapData,
  onSelect,
  onCanvasDrop,
  onWidgetLayout,
}: {
  widgets: CustomWidget[];
  selectedId: string | null;
  canEdit: boolean;
  previewMapData: MapData | null;
  previewBasemaps: CustomBasemap[];
  widgetMapData: Record<string, MapData>;
  onSelect: (id: string | null) => void;
  onCanvasDrop: (kind: CustomWidgetKind, col: number, row: number) => void;
  onWidgetLayout: (id: string, layout: CustomLayout) => void;
}) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [gesture, setGesture] = useState<ActiveGesture | null>(null);

  // Compute the canvas's grid extent from the widgets' bottom-most
  // row so dropping a widget below the current content extends the
  // canvas naturally. Always at least 12 rows so a fresh app has
  // room to drop into.
  const minRows = 12;
  const usedRows = widgets.reduce(
    (n, w) => Math.max(n, w.layout.row + w.layout.rowSpan - 1),
    0,
  );
  const totalRows = Math.max(minRows, usedRows + 4);

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!canEdit) return;
    if (e.dataTransfer.types.includes('text/x-widget-kind')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!canEdit) return;
    const kind = e.dataTransfer.getData('text/x-widget-kind');
    if (!kind) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const colWidth = rect.width / GRID_COLS;
    const col = Math.max(1, Math.min(GRID_COLS, Math.floor(x / colWidth) + 1));
    const row = Math.max(1, Math.floor(y / ROW_HEIGHT_PX) + 1);
    onCanvasDrop(kind as CustomWidgetKind, col, row);
  }

  // Begin a gesture. Called from WidgetCard's mousedown handler
  // (move) and from the resize handles (resize-*). We capture the
  // start point + the widget's starting layout so mousemove can
  // compute deltas without re-reading state.
  const beginGesture = useCallback(
    (
      kind: ActiveGesture['kind'],
      widget: CustomWidget,
      e: ReactMouseEvent<HTMLElement>,
    ) => {
      if (!canEdit) return;
      e.stopPropagation();
      setGesture({
        kind,
        widgetId: widget.id,
        startX: e.clientX,
        startY: e.clientY,
        startLayout: widget.layout,
      });
    },
    [canEdit],
  );

  // Window-level mousemove + mouseup while a gesture is active.
  // We attach to window so the gesture survives the cursor leaving
  // the widget bounds (a normal pattern for drag UX -- letting
  // the cursor jump out of the widget shouldn't cancel the drag).
  useEffect(() => {
    if (!gesture) return;
    // Bind a local non-null alias so TS narrows cleanly inside the
    // closures below; the effect body's null guard above is what
    // actually keeps us safe at runtime.
    const g = gesture;
    function pxPerCol(): number {
      const rect = canvasRef.current?.getBoundingClientRect();
      // 6px gap is included in the grid layout; the column width
      // is approximately (rect.width - 11*6) / 12 but the small
      // gap error rounds out at the snap-to-cell step.
      return rect ? rect.width / GRID_COLS : 100;
    }
    function onMove(e: MouseEvent) {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (
        Math.abs(dx) < DRAG_THRESHOLD_PX &&
        Math.abs(dy) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      const colDelta = Math.round(dx / pxPerCol());
      const rowDelta = Math.round(dy / ROW_HEIGHT_PX);
      const start = g.startLayout;
      const next: CustomLayout = { ...start };
      if (g.kind === 'move') {
        next.col = clampCol(start.col + colDelta);
        next.row = Math.max(1, start.row + rowDelta);
        // Clamp colSpan when the move pushed the right edge past
        // the grid -- otherwise the widget would overflow the
        // canvas after a rightward drag.
        next.colSpan = Math.min(start.colSpan, GRID_COLS - next.col + 1);
      } else if (g.kind === 'resize-r' || g.kind === 'resize-br') {
        next.colSpan = Math.max(
          1,
          Math.min(GRID_COLS - start.col + 1, start.colSpan + colDelta),
        );
      }
      if (g.kind === 'resize-b' || g.kind === 'resize-br') {
        next.rowSpan = Math.max(1, start.rowSpan + rowDelta);
      }
      onWidgetLayout(g.widgetId, next);
    }
    function onUp() {
      setGesture(null);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [gesture, onWidgetLayout]);

  return (
    <div className="relative flex flex-1 overflow-hidden rounded-lg border border-border bg-surface-1">
      <div
        ref={canvasRef}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onClick={() => onSelect(null)}
        // Dot grid background, very subtle. Anchors to (12px, 12px)
        // so the dots don't sit on the widget edges. Position picked
        // empirically against a 24x24px snap grid -- the dots fall
        // on every fourth grid intersection.
        className="relative flex-1 overflow-auto bg-[radial-gradient(circle_at_1px_1px,rgba(0,0,0,0.06)_1px,transparent_0)] bg-[length:24px_24px] p-4"
      >
        {/* The actual grid. CSS Grid makes the placement math cheap:
            each widget's gridColumn / gridRow line up with the
            schema's col/row + spans, no manual translation needed.
            Min-width keeps the canvas usable on narrower viewports
            (matches Experience Builder + Webflow's "fixed canvas
            with horizontal scroll" pattern); on wider viewports the
            grid expands naturally to fill the canvas pane. */}
        <div
          className="grid w-full"
          style={{
            gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
            gridAutoRows: `${ROW_HEIGHT_PX}px`,
            minWidth: `${CANVAS_MIN_WIDTH_PX}px`,
            minHeight: `${totalRows * ROW_HEIGHT_PX}px`,
            gap: '6px',
          }}
        >
          {widgets.map((w) => (
            <WidgetCard
              key={w.id}
              widget={w}
              selected={w.id === selectedId}
              canEdit={canEdit}
              gesturing={Boolean(gesture && gesture.widgetId === w.id)}
              anyGesture={gesture !== null}
              // #363: prefer the widget's own map override if one is
              // resolved, else fall through to the app default.
              previewMapData={widgetMapData[w.id] ?? previewMapData}
              previewBasemaps={previewBasemaps}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(w.id);
              }}
              onMoveStart={(e) => beginGesture('move', w, e)}
              onResizeStart={(handle, e) =>
                beginGesture(
                  handle === 'br'
                    ? 'resize-br'
                    : handle === 'r'
                      ? 'resize-r'
                      : 'resize-b',
                  w,
                  e,
                )
              }
            />
          ))}
          {widgets.length === 0 && (
            <div
              className="flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-surface-1/60 p-8 text-center"
              style={{ gridColumn: '1 / -1', gridRow: '1 / span 12' }}
            >
              <Square className="h-5 w-5 text-muted" strokeWidth={1.5} />
              <p className="text-sm font-medium text-ink-0">Empty canvas</p>
              <p className="text-xs text-muted">
                Drag a widget from the left rail to get started.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Widget card on canvas (placeholder render) ----------------------------

function WidgetCard({
  widget,
  selected,
  canEdit,
  gesturing,
  anyGesture,
  previewMapData,
  previewBasemaps,
  onClick,
  onMoveStart,
  onResizeStart,
}: {
  widget: CustomWidget;
  selected: boolean;
  canEdit: boolean;
  gesturing: boolean;
  anyGesture: boolean;
  previewMapData: MapData | null;
  previewBasemaps: CustomBasemap[];
  onClick: (e: React.MouseEvent) => void;
  onMoveStart: (e: ReactMouseEvent<HTMLElement>) => void;
  onResizeStart: (
    handle: 'br' | 'r' | 'b',
    e: ReactMouseEvent<HTMLElement>,
  ) => void;
}) {
  const tile = PALETTE_TILES.find((t) => t.kind === widget.kind);
  const Icon = tile?.Icon ?? Square;
  const label = tile?.label ?? widget.kind;
  const summary = summarizeWidget(widget);
  // #343: live MapLibre preview for Map widgets. We freeze the
  // preview during ANY canvas gesture (not just the one on this
  // widget) so a drag of a sibling widget doesn't cause MapLibre to
  // re-render mid-frame and stutter.
  const showLivePreview = widget.kind === 'map' && previewMapData !== null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      // mousedown on the body starts a move gesture. The Canvas
      // tracks deltas globally; until the cursor moves past the
      // drag threshold, the click handler still fires for a plain
      // selection. (#338)
      onMouseDown={canEdit ? onMoveStart : undefined}
      style={{
        gridColumn: `${widget.layout.col} / span ${widget.layout.colSpan}`,
        gridRow: `${widget.layout.row} / span ${widget.layout.rowSpan}`,
        cursor: canEdit ? (gesturing ? 'grabbing' : 'grab') : 'default',
      }}
      className={`group relative flex h-full w-full flex-col overflow-hidden rounded-md bg-surface-1 text-left transition-shadow ${
        selected
          ? 'shadow-[0_0_0_2px_var(--color-ink-0,_#0f0f10)]'
          : 'shadow-[0_0_0_1px_var(--color-border,_#e5e7eb)] hover:shadow-[0_0_0_1px_var(--color-ink-1,_#374151)]'
      } ${gesturing ? 'opacity-90' : ''}`}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-1.5 text-xs">
        <Icon className="h-3.5 w-3.5 text-muted" strokeWidth={1.75} />
        <span className="font-medium text-ink-0">{label}</span>
        {summary && (
          <span className="ml-auto truncate text-muted" title={summary}>
            {summary}
          </span>
        )}
      </div>
      {showLivePreview ? (
        <div className="relative flex flex-1 overflow-hidden">
          <MapWidgetPreview
            baseMapData={previewMapData}
            basemaps={previewBasemaps}
            frozen={anyGesture}
          />
        </div>
      ) : widget.config.kind === 'image' && widget.config.url ? (
        // Live preview for the Image widget when a URL is set. No
        // sandboxing concerns -- it's a read-only <img>.
        <div className="relative flex flex-1 overflow-hidden bg-surface-2/40">
          <img
            src={widget.config.url}
            alt={widget.config.alt ?? ''}
            className="pointer-events-none h-full w-full"
            style={{ objectFit: widget.config.objectFit ?? 'contain' }}
          />
        </div>
      ) : widget.config.kind === 'divider' ? (
        // Live preview for the Divider widget. Mirrors the runtime.
        <div className="flex flex-1 items-center px-2">
          <hr
            className="w-full"
            style={{
              borderTop: `${widget.config.thicknessPx ?? 1}px ${widget.config.style ?? 'solid'} ${widget.config.color ?? 'var(--color-border, #e5e7eb)'}`,
              margin: 0,
            }}
          />
        </div>
      ) : widget.config.kind === 'button' ? (
        // Live preview for the Button widget.
        <div className="flex flex-1 items-center justify-center p-2">
          <span
            className={`pointer-events-none inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-medium ${
              (widget.config.variant ?? 'primary') === 'primary'
                ? 'bg-accent text-white'
                : 'border border-border bg-surface-1 text-ink-1'
            }`}
          >
            {widget.config.label || 'Button'}
          </span>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-3 text-xs text-muted">
          {widgetPlaceholderText(widget.kind, label)}
        </div>
      )}
      {/* Resize handles -- only visible when the widget is selected
          AND the user can edit. Three handles cover the common cases
          (right edge for width, bottom edge for height, bottom-right
          corner for both). 8-handle resize can come if anyone
          actually misses it. Each handle stops propagation so the
          mousedown doesn't fall through to the body's move gesture. */}
      {selected && canEdit && (
        <>
          <button
            type="button"
            aria-label="Resize right"
            onMouseDown={(e) => {
              e.stopPropagation();
              onResizeStart('r', e);
            }}
            className="absolute right-0 top-1/2 h-8 w-1.5 -translate-y-1/2 cursor-ew-resize rounded-full bg-accent/60 opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-90"
          />
          <button
            type="button"
            aria-label="Resize bottom"
            onMouseDown={(e) => {
              e.stopPropagation();
              onResizeStart('b', e);
            }}
            className="absolute bottom-0 left-1/2 h-1.5 w-8 -translate-x-1/2 cursor-ns-resize rounded-full bg-accent/60 opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-90"
          />
          <button
            type="button"
            aria-label="Resize"
            onMouseDown={(e) => {
              e.stopPropagation();
              onResizeStart('br', e);
            }}
            className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize rounded-tl-sm bg-accent opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-90"
          />
        </>
      )}
    </div>
  );
}

/**
 * Mid-card preview text for each widget kind. Just a hint so the
 * canvas doesn't render a wall of "X content" -- real renders are
 * in the runtime (#341) and (for Map) the in-designer preview
 * (#343). This is purely cosmetic.
 */
function widgetPlaceholderText(
  kind: CustomWidgetKind,
  label: string,
): string {
  switch (kind) {
    case 'map':
      return 'No map referenced. Pick one in the right rail to preview.';
    case 'search':
      return 'Address + attribute search';
    case 'print':
      return 'Click to print';
    case 'select':
      return 'Click / box / polygon / lasso';
    case 'basemap-gallery':
      return 'Tiles of available basemaps';
    case 'image':
      return 'Paste an image URL in the right rail';
    case 'button':
      return 'Configure label + link in the right rail';
    case 'divider':
      return 'Horizontal rule';
    case 'embed':
      return 'Paste an iframe URL in the right rail';
    default:
      return `${label} content`;
  }
}

function summarizeWidget(w: CustomWidget): string {
  switch (w.config.kind) {
    case 'map':
      return w.config.mapId
        ? `map: ${w.config.mapId.slice(0, 8)}`
        : 'no map bound';
    case 'legend':
    case 'layer-list':
    case 'search':
    case 'print':
    case 'select':
    case 'basemap-gallery':
      return w.config.mapWidgetId
        ? `→ ${w.config.mapWidgetId.slice(0, 6)}`
        : 'pick a map widget';
    case 'attribute-table':
      return `target #${w.config.targetIndex}`;
    case 'text':
      return w.config.preset ?? 'body';
    case 'chart':
      return `${w.config.chartType} of #${w.config.targetIndex}`;
    case 'image':
      return w.config.url ? 'image set' : 'no url';
    case 'button':
      return w.config.label || 'no label';
    case 'divider':
      return w.config.style ?? 'solid';
    case 'embed':
      return w.config.url ? 'url set' : 'no url';
    default:
      return '';
  }
}

// ---- Properties panel ------------------------------------------------------

function AppProperties({
  app,
  page,
  mapTitle,
  canEdit,
  onUpdateApp,
  onUpdatePage,
  onClearMap,
  onPickMap,
}: {
  app: CustomAppData;
  page: CustomPage;
  mapTitle: string | null;
  canEdit: boolean;
  onUpdateApp: (patch: Partial<CustomAppData>) => void;
  onUpdatePage: (patch: Partial<CustomPage>) => void;
  onClearMap: () => void;
  onPickMap: () => void;
}) {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-border px-4 py-3">
        <p className="text-sm font-medium text-ink-0">Page</p>
      </div>
      <div className="space-y-4 p-4 text-sm">
        <Field label="Title">
          <input
            value={page.title}
            disabled={!canEdit}
            onChange={(e) => onUpdatePage({ title: e.target.value })}
            className="w-full rounded-md border border-border bg-surface-1 px-2.5 py-1.5 text-sm focus:border-ink-1 focus:outline-none focus:ring-0"
          />
        </Field>
      </div>
      <div className="border-y border-border px-4 py-3">
        <p className="text-sm font-medium text-ink-0">App settings</p>
      </div>
      <div className="space-y-4 p-4 text-sm">
        <Field
          label="Default map"
          hint="Map widgets that don't set their own use this for basemap + viewport."
        >
          {app.mapId ? (
            <div className="flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1">
              <MapIcon className="h-3.5 w-3.5 text-emerald-600" />
              <span className="flex-1 truncate text-ink-1">
                {mapTitle ?? app.mapId.slice(0, 8)}
              </span>
              {canEdit && (
                <>
                  <button
                    type="button"
                    onClick={onPickMap}
                    className="text-[10px] text-accent hover:underline"
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    onClick={onClearMap}
                    className="text-muted hover:text-rose-600"
                    aria-label="Remove map"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          ) : (
            <button
              type="button"
              disabled={!canEdit}
              onClick={onPickMap}
              className="inline-flex h-7 w-full items-center justify-center gap-1 rounded-md border border-dashed border-border bg-surface-2/30 px-2 text-[11px] text-muted hover:border-accent/40 hover:text-ink-1 disabled:opacity-50"
            >
              <Plus className="h-3 w-3" />
              Pick a map
            </button>
          )}
        </Field>
        <Field
          label="Targets"
          hint="Layers your widgets can bind to. Add via the Map widget's properties (in Slice 3) or the items page for now."
        >
          {app.targets.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-2 py-3 text-center text-xs text-muted">
              No targets yet.
            </div>
          ) : (
            <ul className="space-y-1">
              {app.targets.map((t, i) => (
                <li
                  key={`${t.dataLayerId}:${t.layerKey}`}
                  className="flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-[11px]"
                >
                  <LayersIcon className="h-3.5 w-3.5 text-sky-600" />
                  <span className="flex-1 truncate">
                    {t.dataLayerId.slice(0, 8)} / {t.layerKey}
                  </span>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => {
                        const targets: ViewerTarget[] = app.targets.filter(
                          (_, j) => j !== i,
                        );
                        onUpdateApp({ targets });
                      }}
                      className="text-muted hover:text-rose-600"
                      aria-label="Remove target"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Field>
      </div>
    </div>
  );
}

function WidgetProperties({
  widget,
  canEdit,
  pageWidgets,
  appPages,
  appTargets,
  appMapId,
  appMapTitle,
  mapTitlesById,
  onChange,
  onChangeConfig,
  onPickWidgetMap,
  onRemove,
}: {
  widget: CustomWidget;
  canEdit: boolean;
  pageWidgets: CustomWidget[];
  appPages: CustomPage[];
  appTargets: ViewerTarget[];
  appMapId: string | undefined;
  appMapTitle: string | null;
  mapTitlesById: Record<string, string>;
  onChange: (patch: Partial<CustomWidget>) => void;
  onChangeConfig: (configPatch: Record<string, unknown>) => void;
  onPickWidgetMap: () => void;
  onRemove: () => void;
}) {
  const tile = PALETTE_TILES.find((t) => t.kind === widget.kind);
  const Icon = tile?.Icon ?? Square;
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Icon className="h-4 w-4 text-muted" strokeWidth={1.75} />
        <span className="text-sm font-medium text-ink-0">
          {tile?.label ?? widget.kind}
        </span>
        <span className="ml-auto inline-flex items-center gap-1">
          {canEdit && (
            <button
              type="button"
              onClick={onRemove}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-rose-600"
              title="Remove widget"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          )}
          <MoreVertical className="h-4 w-4 text-muted" strokeWidth={1.75} />
        </span>
      </div>
      <div className="space-y-4 p-4 text-sm">
        <p className="text-sm font-medium text-ink-0">Layout</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Column">
            <NumberInput
              value={widget.layout.col}
              min={1}
              max={GRID_COLS}
              disabled={!canEdit}
              onChange={(v) =>
                onChange({
                  layout: {
                    ...widget.layout,
                    col: clampCol(v),
                    colSpan: Math.min(
                      widget.layout.colSpan,
                      GRID_COLS - clampCol(v) + 1,
                    ),
                  },
                })
              }
            />
          </Field>
          <Field label="Row">
            <NumberInput
              value={widget.layout.row}
              min={1}
              disabled={!canEdit}
              onChange={(v) =>
                onChange({
                  layout: { ...widget.layout, row: Math.max(1, v) },
                })
              }
            />
          </Field>
          <Field label="Width">
            <NumberInput
              value={widget.layout.colSpan}
              min={1}
              max={GRID_COLS}
              disabled={!canEdit}
              onChange={(v) =>
                onChange({
                  layout: {
                    ...widget.layout,
                    colSpan: Math.max(
                      1,
                      Math.min(v, GRID_COLS - widget.layout.col + 1),
                    ),
                  },
                })
              }
            />
          </Field>
          <Field label="Height">
            <NumberInput
              value={widget.layout.rowSpan}
              min={1}
              disabled={!canEdit}
              onChange={(v) =>
                onChange({
                  layout: { ...widget.layout, rowSpan: Math.max(1, v) },
                })
              }
            />
          </Field>
        </div>
        <p className="text-xs leading-snug text-muted">
          Drag the widget on the canvas to move; drag the right,
          bottom, or corner handles to resize. Or enter cells here.
        </p>
        <div className="-mx-4 border-t border-border" />
        <p className="text-sm font-medium text-ink-0">Configuration</p>
        <WidgetConfigForm
          widget={widget}
          canEdit={canEdit}
          pageWidgets={pageWidgets}
          appPages={appPages}
          appTargets={appTargets}
          appMapId={appMapId}
          appMapTitle={appMapTitle}
          mapTitlesById={mapTitlesById}
          onChangeConfig={onChangeConfig}
          onPickWidgetMap={onPickWidgetMap}
        />
      </div>
    </div>
  );
}

/**
 * Per-kind configuration form rendered inside the widget properties
 * panel (#339). Each branch renders the controls relevant to that
 * widget's CustomWidgetConfig shape:
 *
 *   - Map: optional override for the app-level default map; toggle
 *     for the navigation buttons (zoom +/-/home/locate)
 *   - Legend / LayerList / Search / Print / Select / BasemapGallery:
 *     pick which Map widget on this page they bind to. The picker
 *     surfaces every Map widget with a friendly id; auto-bind on
 *     drop already wires the "only one Map" case (#339 helper), so
 *     this form only matters for the "two or more Maps" case or for
 *     fixing a stale binding after deletion / rename.
 *   - AttributeTable: which target index in the app's targets list
 *     this table renders + optional sync to a Map widget so row
 *     selection highlights features
 *   - Text: a markdown body + presentational preset (header / body /
 *     callout)
 *   - Chart: deferred -- the runtime renderer ships with chart last
 *
 * Form layout: tiny fields in muted labels so the panel stays
 * compact. Inputs disabled when canEdit=false (sharee / read-only
 * viewer of the configuration page).
 */
function WidgetConfigForm({
  widget,
  canEdit,
  pageWidgets,
  appPages,
  appTargets,
  appMapId,
  appMapTitle,
  mapTitlesById,
  onChangeConfig,
  onPickWidgetMap,
}: {
  widget: CustomWidget;
  canEdit: boolean;
  pageWidgets: CustomWidget[];
  appPages: CustomPage[];
  appTargets: ViewerTarget[];
  appMapId: string | undefined;
  appMapTitle: string | null;
  mapTitlesById: Record<string, string>;
  onChangeConfig: (configPatch: Record<string, unknown>) => void;
  onPickWidgetMap: () => void;
}) {
  // List of map widgets on this page, used by every map-following
  // kind below to pick a binding.
  const mapWidgets = pageWidgets.filter((w) => w.kind === 'map');
  switch (widget.config.kind) {
    case 'map':
      return (
        <MapWidgetConfig
          config={widget.config}
          canEdit={canEdit}
          appMapId={appMapId}
          appMapTitle={appMapTitle}
          // #363: resolved title for the per-widget override mapId,
          // if one was fetched. Falls back to the UUID stub when the
          // fetch hasn't completed yet (or the map has been deleted).
          widgetMapTitle={
            widget.config.mapId
              ? mapTitlesById[widget.config.mapId] ?? null
              : null
          }
          appTargetCount={appTargets.length}
          onChangeConfig={onChangeConfig}
          onPickMap={onPickWidgetMap}
        />
      );
    case 'legend':
    case 'layer-list':
    case 'search':
    case 'print':
    case 'select':
    case 'basemap-gallery':
      return (
        <MapBindingPicker
          mapWidgetId={widget.config.mapWidgetId}
          mapWidgets={mapWidgets}
          canEdit={canEdit}
          onChange={(mapWidgetId) => onChangeConfig({ mapWidgetId })}
          extra={
            widget.config.kind === 'layer-list' ? (
              <Field label="Allow toggling layers">
                <select
                  value={widget.config.allowToggle === false ? 'no' : 'yes'}
                  disabled={!canEdit}
                  onChange={(e) =>
                    onChangeConfig({
                      allowToggle: e.target.value === 'yes',
                    })
                  }
                  className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
                >
                  <option value="yes">Yes</option>
                  <option value="no">No (read-only)</option>
                </select>
              </Field>
            ) : widget.config.kind === 'search' ? (
              <Field label="Address geocoding">
                <select
                  value={
                    widget.config.geocodingEnabled === false ? 'no' : 'yes'
                  }
                  disabled={!canEdit}
                  onChange={(e) =>
                    onChangeConfig({
                      geocodingEnabled: e.target.value === 'yes',
                    })
                  }
                  className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
                >
                  <option value="yes">Address + attribute search</option>
                  <option value="no">Attribute search only</option>
                </select>
              </Field>
            ) : null
          }
        />
      );
    case 'attribute-table':
      return (
        <div className="space-y-3">
          <Field
            label="Target layer"
            hint={
              appTargets.length === 0
                ? 'No targets defined on the app yet. Add one via the Map widget.'
                : 'The layer this table renders rows from.'
            }
          >
            <select
              value={widget.config.targetIndex}
              disabled={!canEdit || appTargets.length === 0}
              onChange={(e) =>
                onChangeConfig({ targetIndex: Number(e.target.value) })
              }
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
            >
              {appTargets.length === 0 ? (
                <option value={0}>(no targets)</option>
              ) : (
                appTargets.map((t, i) => (
                  <option key={`${t.dataLayerId}:${t.layerKey}`} value={i}>
                    #{i} {t.dataLayerId.slice(0, 8)} / {t.layerKey}
                  </option>
                ))
              )}
            </select>
          </Field>
          <Field
            label="Sync selection with map"
            hint="Optional. When set, clicking a row highlights that feature on the chosen map."
          >
            <select
              value={widget.config.syncWithMapWidgetId ?? ''}
              disabled={!canEdit}
              onChange={(e) =>
                onChangeConfig({
                  syncWithMapWidgetId: e.target.value || undefined,
                })
              }
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
            >
              <option value="">None</option>
              {mapWidgets.map((m) => (
                <option key={m.id} value={m.id}>
                  Map · {m.id.slice(2, 10)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Max rows">
            <NumberInput
              value={widget.config.maxRows ?? 200}
              min={10}
              max={5000}
              disabled={!canEdit}
              onChange={(v) =>
                onChangeConfig({ maxRows: Math.max(10, Math.min(5000, v)) })
              }
            />
          </Field>
        </div>
      );
    case 'text':
      return (
        <div className="space-y-3">
          <Field label="Preset">
            <select
              value={widget.config.preset ?? 'body'}
              disabled={!canEdit}
              onChange={(e) =>
                onChangeConfig({
                  preset: e.target.value as
                    | 'header'
                    | 'subheader'
                    | 'body'
                    | 'callout',
                })
              }
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
            >
              <option value="header">Header</option>
              <option value="subheader">Subheader</option>
              <option value="body">Body</option>
              <option value="callout">Callout</option>
            </select>
          </Field>
          <Field label="Markdown" hint="Bold, italic, links, lists, code.">
            <textarea
              value={widget.config.markdown}
              disabled={!canEdit}
              rows={4}
              onChange={(e) => onChangeConfig({ markdown: e.target.value })}
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
            />
          </Field>
        </div>
      );
    case 'chart':
      return (
        <p className="rounded-md border border-dashed border-border px-2 py-3 text-center text-xs text-muted">
          Chart configuration ships after the runtime (#341).
        </p>
      );
    case 'image':
      return (
        <ImageWidgetConfig
          config={widget.config}
          canEdit={canEdit}
          onChangeConfig={onChangeConfig}
        />
      );
    case 'button':
      return (
        <ButtonWidgetConfig
          config={widget.config}
          canEdit={canEdit}
          pages={appPages}
          onChangeConfig={onChangeConfig}
        />
      );
    case 'divider':
      return (
        <DividerWidgetConfig
          config={widget.config}
          canEdit={canEdit}
          onChangeConfig={onChangeConfig}
        />
      );
    case 'embed':
      return (
        <EmbedWidgetConfig
          config={widget.config}
          canEdit={canEdit}
          onChangeConfig={onChangeConfig}
        />
      );
    default: {
      const _exhaustive: never = widget.config;
      void _exhaustive;
      return null;
    }
  }
}

function MapWidgetConfig({
  config,
  canEdit,
  appMapId,
  appMapTitle,
  widgetMapTitle,
  appTargetCount,
  onChangeConfig,
  onPickMap,
}: {
  config: { kind: 'map'; mapId?: string; showNavigation?: boolean };
  canEdit: boolean;
  appMapId: string | undefined;
  appMapTitle: string | null;
  /** #363: resolved title for the per-widget override mapId, or
   *  null when the fetch is in flight / the map has been deleted. */
  widgetMapTitle: string | null;
  appTargetCount: number;
  onChangeConfig: (patch: Record<string, unknown>) => void;
  onPickMap: () => void;
}) {
  return (
    <div className="space-y-3">
      <Field
        label="Map source"
        hint="Per-widget override. Leave empty to inherit the app's default map."
      >
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1">
          <MapIcon className="h-3.5 w-3.5 text-emerald-600" />
          <span className="flex-1 truncate text-ink-1">
            {config.mapId ? (
              widgetMapTitle ? (
                <span>{widgetMapTitle}</span>
              ) : (
                <span className="font-mono text-[10px]">
                  {config.mapId.slice(0, 12)}...
                </span>
              )
            ) : appMapId ? (
              <>
                <span className="text-muted">app default ·</span>{' '}
                {appMapTitle ?? appMapId.slice(0, 8)}
              </>
            ) : (
              <span className="text-muted">none</span>
            )}
          </span>
          {canEdit && (
            <button
              type="button"
              onClick={onPickMap}
              className="text-[10px] font-medium text-accent hover:underline"
              title={config.mapId ? 'Change override' : 'Pick a map override'}
            >
              {config.mapId ? 'Change' : 'Pick'}
            </button>
          )}
          {canEdit && config.mapId && (
            <button
              type="button"
              onClick={() => onChangeConfig({ mapId: undefined })}
              className="text-muted hover:text-rose-600"
              title="Use app default"
              aria-label="Reset to app default"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      </Field>
      <Field label="Navigation buttons">
        <select
          value={config.showNavigation === false ? 'no' : 'yes'}
          disabled={!canEdit}
          onChange={(e) =>
            onChangeConfig({ showNavigation: e.target.value === 'yes' })
          }
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
        >
          <option value="yes">Show zoom + home + locate</option>
          <option value="no">Hide</option>
        </select>
      </Field>
      <p className="rounded-md border border-dashed border-border bg-surface-2/40 px-2 py-2 text-[10px] text-muted">
        {appTargetCount === 0
          ? 'No targets on the app yet. The runtime will render the map with just the basemap until targets are added.'
          : `${appTargetCount} target layer${appTargetCount === 1 ? '' : 's'} on the app -- this map renders all of them by default.`}
      </p>
    </div>
  );
}

// ---- Page-element widget config editors (#361) -----------------------------

function ImageWidgetConfig({
  config,
  canEdit,
  onChangeConfig,
}: {
  config: { kind: 'image'; url?: string; alt?: string; objectFit?: 'contain' | 'cover' | 'fill' | 'none'; href?: string; openInNewTab?: boolean };
  canEdit: boolean;
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="Image URL" hint="Paste an https URL. Local upload is a follow-up.">
        <input
          type="url"
          value={config.url ?? ''}
          disabled={!canEdit}
          placeholder="https://..."
          onChange={(e) => onChangeConfig({ url: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
        />
      </Field>
      <Field label="Alt text" hint="Describe the image for screen readers. Leave blank if decorative.">
        <input
          type="text"
          value={config.alt ?? ''}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ alt: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
        />
      </Field>
      <Field label="Fit">
        <select
          value={config.objectFit ?? 'contain'}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ objectFit: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm"
        >
          <option value="contain">Contain (letterbox)</option>
          <option value="cover">Cover (crop)</option>
          <option value="fill">Fill (stretch)</option>
          <option value="none">None (actual size)</option>
        </select>
      </Field>
      <Field label="Click target (optional)" hint="When set, the image becomes a link.">
        <input
          type="url"
          value={config.href ?? ''}
          disabled={!canEdit}
          placeholder="https://..."
          onChange={(e) => onChangeConfig({ href: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
        />
      </Field>
      {config.href ? (
        <label className="flex items-center gap-2 text-xs text-ink-1">
          <input
            type="checkbox"
            disabled={!canEdit}
            checked={config.openInNewTab ?? false}
            onChange={(e) => onChangeConfig({ openInNewTab: e.target.checked })}
          />
          Open in a new tab
        </label>
      ) : null}
    </div>
  );
}

function ButtonWidgetConfig({
  config,
  canEdit,
  pages,
  onChangeConfig,
}: {
  config: {
    kind: 'button';
    label: string;
    linkKind?: 'url' | 'page';
    url?: string;
    pageId?: string;
    variant?: 'primary' | 'secondary';
    openInNewTab?: boolean;
  };
  canEdit: boolean;
  pages: CustomPage[];
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  const linkKind = config.linkKind ?? 'url';
  return (
    <div className="space-y-3">
      <Field label="Label">
        <input
          type="text"
          value={config.label ?? ''}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ label: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
        />
      </Field>
      <Field label="Variant">
        <select
          value={config.variant ?? 'primary'}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ variant: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm"
        >
          <option value="primary">Primary (filled)</option>
          <option value="secondary">Secondary (outline)</option>
        </select>
      </Field>
      <Field label="Links to">
        <select
          value={linkKind}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ linkKind: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm"
        >
          <option value="url">External URL</option>
          <option value="page">Page in this app</option>
        </select>
      </Field>
      {linkKind === 'url' ? (
        <>
          <Field label="URL">
            <input
              type="url"
              value={config.url ?? ''}
              disabled={!canEdit}
              placeholder="https://..."
              onChange={(e) => onChangeConfig({ url: e.target.value })}
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
            />
          </Field>
          <label className="flex items-center gap-2 text-xs text-ink-1">
            <input
              type="checkbox"
              disabled={!canEdit}
              checked={config.openInNewTab ?? false}
              onChange={(e) => onChangeConfig({ openInNewTab: e.target.checked })}
            />
            Open in a new tab
          </label>
        </>
      ) : (
        <Field label="Page">
          <select
            value={config.pageId ?? ''}
            disabled={!canEdit || pages.length === 0}
            onChange={(e) => onChangeConfig({ pageId: e.target.value })}
            className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm"
          >
            <option value="">Pick a page</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </Field>
      )}
    </div>
  );
}

function DividerWidgetConfig({
  config,
  canEdit,
  onChangeConfig,
}: {
  config: { kind: 'divider'; thicknessPx?: number; color?: string; style?: 'solid' | 'dashed' | 'dotted' };
  canEdit: boolean;
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="Style">
        <select
          value={config.style ?? 'solid'}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ style: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm"
        >
          <option value="solid">Solid</option>
          <option value="dashed">Dashed</option>
          <option value="dotted">Dotted</option>
        </select>
      </Field>
      <Field label="Thickness (px)">
        <NumberInput
          value={config.thicknessPx ?? 1}
          min={1}
          max={8}
          disabled={!canEdit}
          onChange={(v) => onChangeConfig({ thicknessPx: v })}
        />
      </Field>
      <Field label="Color (CSS)" hint="Hex, rgb, or any CSS color. Leave blank to inherit border color.">
        <input
          type="text"
          value={config.color ?? ''}
          disabled={!canEdit}
          placeholder="#e5e7eb"
          onChange={(e) => onChangeConfig({ color: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
        />
      </Field>
    </div>
  );
}

function EmbedWidgetConfig({
  config,
  canEdit,
  onChangeConfig,
}: {
  config: { kind: 'embed'; url?: string; title?: string; strict?: boolean };
  canEdit: boolean;
  onChangeConfig: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="URL" hint="https only. Some sites refuse to be iframed (X-Frame-Options); test in the runtime.">
        <input
          type="url"
          value={config.url ?? ''}
          disabled={!canEdit}
          placeholder="https://..."
          onChange={(e) => onChangeConfig({ url: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
        />
      </Field>
      <Field label="Title" hint="Used for assistive tech. Defaults to the URL when blank.">
        <input
          type="text"
          value={config.title ?? ''}
          disabled={!canEdit}
          onChange={(e) => onChangeConfig({ title: e.target.value })}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm focus:border-ink-1 focus:outline-none"
        />
      </Field>
      <label className="flex items-center gap-2 text-xs text-ink-1">
        <input
          type="checkbox"
          disabled={!canEdit}
          checked={config.strict ?? false}
          onChange={(e) => onChangeConfig({ strict: e.target.checked })}
        />
        Strict sandbox (recommended for untrusted URLs)
      </label>
    </div>
  );
}

function MapBindingPicker({
  mapWidgetId,
  mapWidgets,
  canEdit,
  onChange,
  extra,
}: {
  mapWidgetId: string;
  mapWidgets: CustomWidget[];
  canEdit: boolean;
  onChange: (next: string) => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <Field
        label="Bound map"
        hint={
          mapWidgets.length === 0
            ? 'Drop a Map widget on the page first.'
            : 'The Map widget this control operates on.'
        }
      >
        <select
          value={mapWidgetId}
          disabled={!canEdit || mapWidgets.length === 0}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
        >
          <option value="">
            {mapWidgets.length === 0 ? '(no map widgets)' : 'Pick a map…'}
          </option>
          {mapWidgets.map((m) => (
            <option key={m.id} value={m.id}>
              Map · {m.id.slice(2, 10)}
            </option>
          ))}
        </select>
      </Field>
      {extra}
    </div>
  );
}

// ---- Generic field + number input -----------------------------------------

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-ink-1">{label}</label>
      {children}
      {hint && <p className="text-xs leading-snug text-muted">{hint}</p>}
    </div>
  );
}

function NumberInput({
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
      className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
    />
  );
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Widget kinds whose CustomWidgetConfig has a `mapWidgetId` field
 * the runtime needs filled to do anything useful. addWidgetAt
 * uses this set to decide whether to auto-bind a freshly-dropped
 * widget to the only Map widget on the page; the WidgetConfigForm
 * uses the same shape (a map-binding picker) for them all.
 */
const WIDGETS_BIND_MAP_ID = new Set<CustomWidgetKind>([
  'legend',
  'layer-list',
  'search',
  'print',
  'select',
  'basemap-gallery',
]);

/**
 * Pre-fill `mapWidgetId` on a freshly-stamped widget without any
 * exhaustive switch over CustomWidgetConfig: the field is uniformly
 * called `mapWidgetId` across every config kind in the set above,
 * so a structural copy with the patch applied is type-safe via the
 * eventual cast back to CustomWidget.
 */
function autoBindMapWidgetId(
  widget: CustomWidget,
  mapWidgetId: string,
): CustomWidget {
  return {
    ...widget,
    config: {
      ...widget.config,
      mapWidgetId,
    } as CustomWidget['config'],
  };
}

function clampCol(col: number): number {
  return Math.max(1, Math.min(GRID_COLS, Math.round(col)));
}

/**
 * Default size + position for a freshly-stamped widget. Map gets
 * the largest footprint by default because most apps anchor on it;
 * other widgets get sensible smaller blocks. col/row are placeholder
 * 1,1 -- the canvas's drop handler overrides them with the actual
 * grid cell the user dropped into.
 */
function defaultLayoutForKind(kind: CustomWidgetKind): CustomLayout {
  // Sizes are in v2 grid units (24 cols x 24px rows). 1 v2 col is
  // half the width of the old v1 col; 1 v2 row is half the height.
  // So a Map that used to be 8x12 in v1 is 16x24 in v2 (same
  // physical space, finer snap).
  switch (kind) {
    case 'map':
      return { col: 1, row: 1, colSpan: 16, rowSpan: 24 };
    case 'layer-list':
      return { col: 1, row: 1, colSpan: 8, rowSpan: 16 };
    case 'legend':
      return { col: 1, row: 1, colSpan: 8, rowSpan: 12 };
    case 'attribute-table':
      return { col: 1, row: 1, colSpan: 24, rowSpan: 10 };
    case 'text':
      return { col: 1, row: 1, colSpan: 24, rowSpan: 2 };
    case 'chart':
      return { col: 1, row: 1, colSpan: 12, rowSpan: 12 };
    case 'search':
      // Compact search bar typically dropped at the top of the
      // canvas. Wide enough to hold a placeholder + result list.
      return { col: 1, row: 1, colSpan: 12, rowSpan: 2 };
    case 'print':
      return { col: 1, row: 1, colSpan: 4, rowSpan: 2 };
    case 'select':
      return { col: 1, row: 1, colSpan: 8, rowSpan: 2 };
    case 'basemap-gallery':
      return { col: 1, row: 1, colSpan: 8, rowSpan: 8 };
    case 'image':
      return { col: 1, row: 1, colSpan: 8, rowSpan: 8 };
    case 'button':
      return { col: 1, row: 1, colSpan: 4, rowSpan: 2 };
    case 'divider':
      return { col: 1, row: 1, colSpan: 24, rowSpan: 1 };
    case 'embed':
      return { col: 1, row: 1, colSpan: 16, rowSpan: 16 };
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return { col: 1, row: 1, colSpan: 12, rowSpan: 8 };
    }
  }
}

/**
 * Stamp a fresh widget of `kind` with sensible config defaults.
 * Same idea as the previous structural editor's stampWidget; kept
 * here so the designer doesn't depend on the legacy detail page.
 */
function stampWidget(kind: CustomWidgetKind, layout: CustomLayout): CustomWidget {
  const id = `w_${Math.random().toString(36).slice(2, 10)}`;
  switch (kind) {
    case 'map':
      return { id, kind, layout, config: { kind: 'map' } };
    case 'legend':
      return { id, kind, layout, config: { kind: 'legend', mapWidgetId: '' } };
    case 'layer-list':
      return {
        id,
        kind,
        layout,
        config: { kind: 'layer-list', mapWidgetId: '' },
      };
    case 'attribute-table':
      return {
        id,
        kind,
        layout,
        config: { kind: 'attribute-table', targetIndex: 0 },
      };
    case 'text':
      return {
        id,
        kind,
        layout,
        config: { kind: 'text', markdown: 'New text widget', preset: 'body' },
      };
    case 'chart':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'chart',
          targetIndex: 0,
          chartType: 'bar',
          aggregate: 'count',
        },
      };
    case 'search':
      return {
        id,
        kind,
        layout,
        config: { kind: 'search', mapWidgetId: '', geocodingEnabled: true },
      };
    case 'print':
      return {
        id,
        kind,
        layout,
        config: { kind: 'print', mapWidgetId: '' },
      };
    case 'select':
      return {
        id,
        kind,
        layout,
        config: { kind: 'select', mapWidgetId: '' },
      };
    case 'basemap-gallery':
      return {
        id,
        kind,
        layout,
        config: { kind: 'basemap-gallery', mapWidgetId: '' },
      };
    case 'image':
      return {
        id,
        kind,
        layout,
        config: { kind: 'image', objectFit: 'contain' },
      };
    case 'button':
      return {
        id,
        kind,
        layout,
        config: {
          kind: 'button',
          label: 'Button',
          variant: 'primary',
          linkKind: 'url',
        },
      };
    case 'divider':
      return {
        id,
        kind,
        layout,
        config: { kind: 'divider', thicknessPx: 1, style: 'solid' },
      };
    case 'embed':
      return {
        id,
        kind,
        layout,
        config: { kind: 'embed' },
      };
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unhandled widget kind: ${String(_exhaustive)}`);
    }
  }
}
