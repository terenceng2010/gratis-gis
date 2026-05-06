'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ExternalLink,
  Layers as LayersIcon,
  Loader2,
  Map as MapIcon,
  Plus,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react';
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
 * Custom Web App detail page (#261). Phase-1 surface: structural
 * editor (pick map, manage targets list, list pages + widgets) plus
 * the same Save / Open chrome the Viewer / Survey detail pages use.
 *
 * The full drag-drop visual designer (12-column grid, widget palette,
 * inline preview) lands in a follow-up slice on top of this scaffolding.
 * Today the page lets the author:
 *
 *   1. Bind an optional default map (drives basemap + viewport for
 *      MapWidgets that don't override).
 *   2. Add / remove app-level targets (the layers widgets can bind
 *      to). Reuses the same shape as Viewer.
 *   3. See pages + widget counts; add a page; rename pages.
 *   4. Click "Open" to navigate to the runtime, which is a placeholder
 *      until the designer ships. Owners can preview the empty-state
 *      that end users will see today.
 */
export function CustomAppDetail({ itemId, initial, canEdit }: Props) {
  const [app, setApp] = useState<CustomAppData>(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickingMap, setPickingMap] = useState(false);

  // Resolved referenced map title (optional).
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
        // Silent: a missing map just means the runtime falls back
        // to the default basemap.
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

  const addPage = useCallback(() => {
    const next: CustomPage = {
      id: `p_${Math.random().toString(36).slice(2, 10)}`,
      title: `Page ${app.pages.length + 1}`,
      widgets: [],
    };
    updateApp({ pages: [...app.pages, next] });
  }, [app.pages, updateApp]);

  const renamePage = useCallback(
    (idx: number, title: string) => {
      const pages = app.pages.map((p, i) => (i === idx ? { ...p, title } : p));
      updateApp({ pages });
    },
    [app.pages, updateApp],
  );

  const removePage = useCallback(
    (idx: number) => {
      // Don't allow removing the last page; the runtime needs at
      // least one page to render.
      if (app.pages.length <= 1) return;
      const pages = app.pages.filter((_, i) => i !== idx);
      updateApp({ pages });
    },
    [app.pages, updateApp],
  );

  const addWidget = useCallback(
    (pageIdx: number, kind: CustomWidgetKind) => {
      // Stamp a sensible default layout: full-width by default,
      // 4 rows tall. The designer's drag-resize will adjust later.
      const layout: CustomLayout = { col: 1, row: 1, colSpan: 12, rowSpan: 4 };
      const widget = stampWidget(kind, layout);
      const pages = app.pages.map((p, i) =>
        i === pageIdx ? { ...p, widgets: [...p.widgets, widget] } : p,
      );
      updateApp({ pages });
    },
    [app.pages, updateApp],
  );

  return (
    <div className="space-y-4">
      {/* Header card: status + Save + Open ------------------------------ */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <div className="flex items-center gap-3">
          <Sparkles className="h-5 w-5 text-amber-500" />
          <div>
            <div className="text-sm font-semibold text-ink-0">
              Custom web app
            </div>
            <div className="text-xs text-muted">
              {app.pages.length} page{app.pages.length === 1 ? '' : 's'} ·{' '}
              {app.pages.reduce((n, p) => n + p.widgets.length, 0)} widget
              {app.pages.reduce((n, p) => n + p.widgets.length, 0) === 1
                ? ''
                : 's'}
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
            Open
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      {/* Reference map -------------------------------------------------- */}
      <div className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <MapIcon className="h-4 w-4 text-emerald-600" />
            <span className="text-sm font-semibold text-ink-0">
              Default map
            </span>
            <span className="text-xs text-muted">(optional)</span>
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={() => setPickingMap(true)}
              className="rounded-md border border-border bg-surface-1 px-2 py-1 text-xs font-medium text-ink-1 hover:bg-surface-2"
            >
              {app.mapId ? 'Change' : 'Pick map'}
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted">
          Map widgets that don&apos;t set their own map fall back to this one
          for basemap and viewport. Skip if every widget will pick its own.
        </p>
        {app.mapId ? (
          <div className="mt-2 inline-flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1 text-xs text-ink-1">
            <MapIcon className="h-3.5 w-3.5 text-emerald-600" />
            {mapTitle ?? app.mapId.slice(0, 8)}
            {canEdit && (
              <button
                type="button"
                onClick={() => {
                  // exactOptionalPropertyTypes: setting mapId to
                  // undefined trips the strictness check; rebuild
                  // the object without the key instead.
                  setApp((cur) => {
                    const { mapId: _drop, ...rest } = cur;
                    void _drop;
                    return rest;
                  });
                  setDirty(true);
                }}
                className="text-muted hover:text-rose-600"
                aria-label="Remove map"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ) : (
          <div className="mt-2 text-xs italic text-muted">No default map.</div>
        )}
      </div>

      {/* Targets -------------------------------------------------------- */}
      <div className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <LayersIcon className="h-4 w-4 text-sky-600" />
            <span className="text-sm font-semibold text-ink-0">Targets</span>
            <span className="text-xs text-muted">
              ({app.targets.length} layer{app.targets.length === 1 ? '' : 's'})
            </span>
          </div>
        </div>
        <p className="mt-1 text-xs text-muted">
          Layers your widgets can bind to. The drag-drop designer&apos;s
          &quot;Add widget&quot; flow lists these as choices.
        </p>
        {app.targets.length === 0 ? (
          <div className="mt-3 rounded-md border border-dashed border-border bg-surface-2 px-3 py-4 text-center text-xs italic text-muted">
            No targets yet. The designer will surface an Add affordance once
            the visual canvas ships.
          </div>
        ) : (
          <ul className="mt-3 space-y-1">
            {app.targets.map((t, i) => (
              <li
                key={`${t.dataLayerId}:${t.layerKey}`}
                className="flex items-center justify-between rounded-md bg-surface-2 px-2 py-1 text-xs text-ink-1"
              >
                <span className="truncate">
                  {t.dataLayerId.slice(0, 8)} / {t.layerKey}
                </span>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => {
                      const targets: ViewerTarget[] = app.targets.filter(
                        (_, j) => j !== i,
                      );
                      updateApp({ targets });
                    }}
                    className="text-muted hover:text-rose-600"
                    aria-label="Remove target"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Pages ---------------------------------------------------------- */}
      <div className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-indigo-600" />
            <span className="text-sm font-semibold text-ink-0">Pages</span>
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={addPage}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs font-medium text-ink-1 hover:bg-surface-2"
            >
              <Plus className="h-3.5 w-3.5" />
              Add page
            </button>
          )}
        </div>
        <ul className="mt-3 space-y-2">
          {app.pages.map((page, i) => (
            <li
              key={page.id}
              className="rounded-md border border-border bg-surface-2 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                {canEdit ? (
                  <input
                    value={page.title}
                    onChange={(e) => renamePage(i, e.target.value)}
                    className="flex-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-ink-0 focus:outline-none focus:ring-1 focus:ring-accent/40"
                  />
                ) : (
                  <span className="text-xs font-medium text-ink-0">
                    {page.title}
                  </span>
                )}
                <span className="text-xs text-muted">
                  {page.widgets.length} widget
                  {page.widgets.length === 1 ? '' : 's'}
                </span>
                {canEdit && app.pages.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removePage(i)}
                    className="text-muted hover:text-rose-600"
                    aria-label="Remove page"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {/* Quick-add widget kind picker. The full designer
                  replaces this with a drag-drop palette. */}
              {canEdit && (
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-muted">
                    Add:
                  </span>
                  {(
                    [
                      'map',
                      'legend',
                      'layer-list',
                      'attribute-table',
                      'text',
                      'chart',
                    ] as CustomWidgetKind[]
                  ).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => addWidget(i, kind)}
                      className="inline-flex items-center rounded-md border border-border bg-surface-1 px-2 py-0.5 text-[11px] text-ink-1 hover:bg-surface-2"
                    >
                      {kind}
                    </button>
                  ))}
                </div>
              )}
              {page.widgets.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {page.widgets.map((w) => (
                    <li
                      key={w.id}
                      className="flex items-center justify-between rounded-md bg-surface-1 px-2 py-1 text-[11px] text-ink-1"
                    >
                      <span className="font-medium">{w.kind}</span>
                      <span className="text-muted">
                        {w.layout.col},{w.layout.row} ·{' '}
                        {w.layout.colSpan}x{w.layout.rowSpan}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
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

/**
 * Stamp a fresh widget of `kind` with sensible defaults. The designer's
 * "Add widget" flow calls this; it gives every widget a stable id +
 * a config object that won't crash the runtime if the user opens the
 * runtime before configuring.
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
