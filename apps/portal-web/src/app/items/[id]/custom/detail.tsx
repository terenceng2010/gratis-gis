'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
} from 'react';
import {
  AlertTriangle,
  BarChart3,
  ExternalLink,
  Eye,
  Layers as LayersIcon,
  ListTree,
  Loader2,
  Map as MapIcon,
  MoreVertical,
  Plus,
  Settings,
  Sparkles,
  Square,
  Table2,
  Trash2,
  Type as TypeIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  CustomAppData,
  CustomLayout,
  CustomPage,
  CustomWidget,
  CustomWidgetKind,
  Item,
  ViewerTarget,
  WebAppData,
} from '@gratis-gis/shared-types';
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
  const [app, setApp] = useState<CustomAppData>(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickingMap, setPickingMap] = useState(false);
  // Single-page UX in Slice 1: home page is always pages[0]. The
  // page tabs + multi-page switcher come in #342.
  const activePageIdx = 0;
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);

  // Resolved referenced map title (optional). Same lazy-fetch as the
  // previous detail page.
  const [mapTitle, setMapTitle] = useState<string | null>(null);
  useEffect(() => {
    if (!app.mapId) {
      setMapTitle(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/portal/items/${app.mapId}`);
        if (cancelled) return;
        if (!res.ok) return;
        const item = (await res.json()) as Item;
        setMapTitle(item.title);
      } catch {
        /* silent: missing map falls through to default basemap */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [app.mapId]);

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
    [],
  );

  const removeWidget = useCallback((widgetId: string) => {
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
  }, []);

  const addWidgetAt = useCallback(
    (kind: CustomWidgetKind, col: number, row: number) => {
      const layout: CustomLayout = {
        ...defaultLayoutForKind(kind),
        col: clampCol(col),
        row: Math.max(1, Math.round(row)),
      };
      const widget = stampWidget(kind, layout);
      setApp((cur) => ({
        ...cur,
        pages: cur.pages.map((p, i) =>
          i !== activePageIdx
            ? p
            : { ...p, widgets: [...p.widgets, widget] },
        ),
      }));
      setSelectedWidgetId(widget.id);
      setDirty(true);
    },
    [],
  );

  const activePage = app.pages[activePageIdx]!;
  const selectedWidget =
    activePage.widgets.find((w) => w.id === selectedWidgetId) ?? null;

  return (
    <div className="space-y-3">
      {/* Header card: status + Save + Open ------------------------------ */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-1 p-3 shadow-card">
        <div className="flex items-center gap-3">
          <Sparkles className="h-5 w-5 text-amber-500" />
          <div>
            <div className="text-sm font-semibold text-ink-0">
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

        {/* CENTER: canvas */}
        <Canvas
          widgets={activePage.widgets}
          selectedId={selectedWidgetId}
          canEdit={canEdit}
          onSelect={setSelectedWidgetId}
          onCanvasDrop={(kind, col, row) => addWidgetAt(kind, col, row)}
        />

        {/* RIGHT: properties panel */}
        <aside className="flex w-72 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
          {selectedWidget ? (
            <WidgetProperties
              widget={selectedWidget}
              canEdit={canEdit}
              onChange={(patch) => updateWidget(selectedWidget.id, patch)}
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
              onPickMap={() => setPickingMap(true)}
            />
          )}
        </aside>
      </div>

      <PickMapDialog
        open={pickingMap}
        onPick={(picked) => {
          updateApp({ mapId: picked.id });
          setPickingMap(false);
        }}
        onClose={() => setPickingMap(false)}
      />
    </div>
  );
}

// ---- Palette ---------------------------------------------------------------

const PALETTE_TILES: Array<{
  kind: CustomWidgetKind;
  label: string;
  Icon: LucideIcon;
  hint: string;
}> = [
  { kind: 'map', label: 'Map', Icon: MapIcon, hint: 'The main map canvas' },
  {
    kind: 'layer-list',
    label: 'Layers',
    Icon: LayersIcon,
    hint: 'Layer toggles + ordering for a map',
  },
  {
    kind: 'legend',
    label: 'Legend',
    Icon: ListTree,
    hint: 'Symbology of visible layers',
  },
  {
    kind: 'attribute-table',
    label: 'Attribute Table',
    Icon: Table2,
    hint: 'Rows from one of the app targets',
  },
  {
    kind: 'text',
    label: 'Text',
    Icon: TypeIcon,
    hint: 'Headings, intros, attributions',
  },
  {
    kind: 'chart',
    label: 'Chart',
    Icon: BarChart3,
    hint: 'Bar / line / pie over a target',
  },
];

function Palette({ canEdit }: { canEdit: boolean }) {
  return (
    <aside className="flex w-56 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
      <div className="border-b border-border bg-surface-2/40 px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          Widgets
        </p>
        <p className="text-[10px] text-muted">
          {canEdit ? 'Drag onto the canvas' : 'Read only'}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 overflow-auto p-2">
        {PALETTE_TILES.map((tile) => (
          <PaletteTile key={tile.kind} {...tile} canEdit={canEdit} />
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
      className="flex aspect-square cursor-grab flex-col items-center justify-center gap-1 rounded-md border border-border bg-surface-1 p-2 text-center text-[11px] text-ink-1 hover:border-accent/40 hover:bg-surface-2 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-5 w-5 text-accent" />
      <span className="font-medium">{label}</span>
    </button>
  );
}

// ---- Canvas -----------------------------------------------------------------

const ROW_HEIGHT_PX = 48;
const GRID_COLS = 12;

function Canvas({
  widgets,
  selectedId,
  canEdit,
  onSelect,
  onCanvasDrop,
}: {
  widgets: CustomWidget[];
  selectedId: string | null;
  canEdit: boolean;
  onSelect: (id: string | null) => void;
  onCanvasDrop: (kind: CustomWidgetKind, col: number, row: number) => void;
}) {
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

  return (
    <div className="relative flex flex-1 overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
      <div
        onDragOver={onDragOver}
        onDrop={onDrop}
        onClick={() => onSelect(null)}
        className="relative flex-1 overflow-auto bg-[linear-gradient(to_right,rgba(0,0,0,0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgba(0,0,0,0.04)_1px,transparent_1px)] bg-[size:8.333%_48px] p-3"
      >
        {/* The actual grid. CSS Grid makes the placement math cheap:
            each widget's gridColumn / gridRow line up with the
            schema's col/row + spans, no manual translation needed. */}
        <div
          className="grid w-full"
          style={{
            gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
            gridAutoRows: `${ROW_HEIGHT_PX}px`,
            minHeight: `${totalRows * ROW_HEIGHT_PX}px`,
            gap: '6px',
          }}
        >
          {widgets.map((w) => (
            <WidgetCard
              key={w.id}
              widget={w}
              selected={w.id === selectedId}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(w.id);
              }}
            />
          ))}
          {widgets.length === 0 && (
            <div
              className="col-span-12 row-span-6 flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-border/70 bg-surface-2/40 p-6 text-center"
              style={{ gridColumn: '1 / -1', gridRow: '1 / span 6' }}
            >
              <Square className="h-6 w-6 text-muted" />
              <p className="text-sm text-ink-1">Empty canvas</p>
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
  onClick,
}: {
  widget: CustomWidget;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  const tile = PALETTE_TILES.find((t) => t.kind === widget.kind);
  const Icon = tile?.Icon ?? Square;
  const label = tile?.label ?? widget.kind;
  const summary = summarizeWidget(widget);

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        gridColumn: `${widget.layout.col} / span ${widget.layout.colSpan}`,
        gridRow: `${widget.layout.row} / span ${widget.layout.rowSpan}`,
      }}
      className={`group relative flex h-full w-full flex-col overflow-hidden rounded-md border-2 bg-surface-1 text-left transition-colors ${
        selected
          ? 'border-accent bg-accent/5 ring-1 ring-accent/40'
          : 'border-border hover:border-accent/40'
      }`}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface-2/40 px-2 py-1 text-[11px]">
        <Icon className="h-3.5 w-3.5 text-accent" />
        <span className="font-medium text-ink-0">{label}</span>
        {summary && (
          <span className="ml-auto truncate text-muted" title={summary}>
            {summary}
          </span>
        )}
      </div>
      <div className="flex flex-1 items-center justify-center p-2 text-[11px] italic text-muted">
        {widget.kind === 'map'
          ? 'Map preview lands in #343'
          : `${label} content`}
      </div>
    </button>
  );
}

function summarizeWidget(w: CustomWidget): string {
  switch (w.config.kind) {
    case 'map':
      return w.config.mapId
        ? `map: ${w.config.mapId.slice(0, 8)}`
        : 'no map bound';
    case 'legend':
    case 'layer-list':
      return w.config.mapWidgetId
        ? `→ ${w.config.mapWidgetId.slice(0, 6)}`
        : 'pick a map widget';
    case 'attribute-table':
      return `target #${w.config.targetIndex}`;
    case 'text':
      return w.config.preset ?? 'body';
    case 'chart':
      return `${w.config.chartType} of #${w.config.targetIndex}`;
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
      <div className="border-b border-border bg-surface-2/40 px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          Page
        </p>
      </div>
      <div className="space-y-3 p-3 text-xs">
        <Field label="Title">
          <input
            value={page.title}
            disabled={!canEdit}
            onChange={(e) => onUpdatePage({ title: e.target.value })}
            className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs"
          />
        </Field>
      </div>
      <div className="border-y border-border bg-surface-2/40 px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          App settings
        </p>
      </div>
      <div className="space-y-3 p-3 text-xs">
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
            <div className="rounded-md border border-dashed border-border bg-surface-2/40 px-2 py-3 text-center text-[11px] italic text-muted">
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
  onChange,
  onRemove,
}: {
  widget: CustomWidget;
  canEdit: boolean;
  onChange: (patch: Partial<CustomWidget>) => void;
  onRemove: () => void;
}) {
  const tile = PALETTE_TILES.find((t) => t.kind === widget.kind);
  const Icon = tile?.Icon ?? Square;
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-border bg-surface-2/40 px-3 py-2">
        <Icon className="h-4 w-4 text-accent" />
        <span className="text-sm font-semibold text-ink-0">
          {tile?.label ?? widget.kind}
        </span>
        <span className="ml-auto inline-flex items-center gap-1">
          {canEdit && (
            <button
              type="button"
              onClick={onRemove}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-1 hover:text-rose-600"
              title="Remove widget"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          <MoreVertical className="h-3.5 w-3.5 text-muted" />
        </span>
      </div>
      <div className="space-y-3 p-3 text-xs">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          Layout
        </p>
        <div className="grid grid-cols-2 gap-2">
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
        <p className="text-[10px] italic text-muted">
          Drag-to-resize + drag-to-reposition arrive in #338. For now,
          enter cells manually.
        </p>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          Configuration
        </p>
        <p className="rounded-md border border-dashed border-border bg-surface-2/40 px-2 py-3 text-center text-[11px] italic text-muted">
          Per-widget config arrives in #339. Today widgets render with
          their default behavior at runtime.
        </p>
      </div>
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
    <div className="space-y-1">
      <label className="text-[10px] font-medium uppercase tracking-wide text-muted">
        {label}
      </label>
      {children}
      {hint && <p className="text-[10px] text-muted">{hint}</p>}
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
  switch (kind) {
    case 'map':
      return { col: 1, row: 1, colSpan: 8, rowSpan: 12 };
    case 'layer-list':
      return { col: 1, row: 1, colSpan: 4, rowSpan: 8 };
    case 'legend':
      return { col: 1, row: 1, colSpan: 4, rowSpan: 6 };
    case 'attribute-table':
      return { col: 1, row: 1, colSpan: 12, rowSpan: 5 };
    case 'text':
      return { col: 1, row: 1, colSpan: 12, rowSpan: 1 };
    case 'chart':
      return { col: 1, row: 1, colSpan: 6, rowSpan: 6 };
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return { col: 1, row: 1, colSpan: 6, rowSpan: 4 };
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
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unhandled widget kind: ${String(_exhaustive)}`);
    }
  }
}
