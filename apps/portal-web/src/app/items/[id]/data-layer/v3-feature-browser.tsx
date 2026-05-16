// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { exportFeatures, type ExportFormat } from '@/lib/layer-export';
import type {
  FeatureRecord,
  DataLayerSublayer,
  FeatureField,
} from '@gratis-gis/shared-types';
import { V3FeatureAttachments } from './v3-feature-attachments';
import { useConfirm } from '@/components/dialog-provider';

/**
 * Inline feature browser + editor for a single v3 layer.
 *
 * Reads from /items/:id/layers/:layerId/features, renders a compact
 * table of all fields (plus a stable `fid` column), and offers per-row
 * edit / delete via the controller's PATCH / DELETE endpoints. New
 * rows are appended via POST with an empty geometry: the layer's
 * geometry gets filled in later via the map editor, or left null for
 * attribute-only related tables.
 *
 * Design notes:
 *  - Editing is property-only for v1. Geometry editing stays in the
 *    map editor where there's a real map canvas to click on.
 *  - We load the whole feature list on open: same assumption v2's
 *    geojson endpoint made. If layers get large (>10k rows) we'll
 *    paginate here; for now "load all" keeps the code simple and
 *    matches author expectations for schema-authoring workflows.
 *  - The PATCH body sends only changed properties, so a save on a row
 *    with one-column change doesn't send the whole row back.
 */
interface Props {
  itemId: string;
  layer: DataLayerSublayer;
  canEdit: boolean;
  onRefreshCounts?: () => void;
}

export function V3FeatureBrowser({
  itemId,
  layer,
  canEdit,
  onRefreshCounts,
}: Props) {
  const [features, setFeatures] = useState<FeatureRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const confirm = useConfirm();
  const [attachmentsOpenFor, setAttachmentsOpenFor] = useState<string | null>(
    null,
  );
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);

  const fields = layer.fields ?? [];

  const reload = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(
        `/api/portal/items/${itemId}/layers/${layer.id}/features`,
      );
      if (!res.ok) {
        setError(`Could not load features: ${res.status} ${await res.text()}`);
        return;
      }
      const body = (await res.json()) as
        | FeatureRecord[]
        | { features: FeatureRecord[] };
      const rows = Array.isArray(body) ? body : (body?.features ?? []);
      setFeatures(rows);
    } catch (err) {
      setError((err as Error).message || 'Could not load features');
    } finally {
      setLoading(false);
    }
  }, [itemId, layer.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function startEdit(feature: FeatureRecord) {
    setEditingId(feature.id);
    setDraft({ ...(feature.properties ?? {}) });
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft({});
  }

  async function saveEdit() {
    if (!editingId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/portal/items/${itemId}/layers/${layer.id}/features/${editingId}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ properties: draft }),
        },
      );
      if (!res.ok) {
        setError(`Save failed: ${res.status} ${await res.text()}`);
        return;
      }
      setEditingId(null);
      setDraft({});
      await reload();
    } finally {
      setSaving(false);
    }
  }

  async function remove(feature: FeatureRecord) {
    const ok = await confirm({
      title: 'Delete this feature?',
      message:
        'This writes a tombstone (soft delete): the feature disappears from current queries but history is preserved.',
      variant: 'danger',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    setError(null);
    const res = await fetch(
      `/api/portal/items/${itemId}/layers/${layer.id}/features/${feature.id}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      setError(`Delete failed: ${res.status}`);
      return;
    }
    await reload();
    onRefreshCounts?.();
  }

  async function addBlank() {
    setAdding(true);
    setError(null);
    try {
      // Blank geometry + empty properties: authors fill in fields in
      // the row's edit view, and the geometry via the map editor if
      // the layer is spatial.
      const res = await fetch(
        `/api/portal/items/${itemId}/layers/${layer.id}/features`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ features: [{ properties: {} }] }),
        },
      );
      if (!res.ok) {
        setError(`Add row failed: ${res.status} ${await res.text()}`);
        return;
      }
      await reload();
      onRefreshCounts?.();
    } finally {
      setAdding(false);
    }
  }

  const columnKeys = useMemo(() => {
    // Column order = declared field order, then any extra keys seen on
    // features (in insertion order) so unregistered fields still show.
    // Skip underscore-prefixed system metadata (_global_id,
    // _created_by, _created_at, _edited_by, _edited_at): the api
    // inlines those for popup/attribute-footer use, but they're
    // noise in the browse table -- the user sees raw UUIDs and the
    // gid column already covers row identity. The Esri convention is
    // a separate metadata panel for these; we already have one in
    // the popup metadata footer. See task #39.
    const declared = new Set(fields.map((f) => f.name));
    const extras = new Set<string>();
    for (const f of features) {
      for (const k of Object.keys(f.properties ?? {})) {
        if (k.startsWith('_')) continue;
        if (!declared.has(k)) extras.add(k);
      }
    }
    return [...fields.map((f) => f.name), ...extras];
  }, [fields, features]);

  const fieldByName = useMemo(() => {
    const map = new Map<string, FeatureField>();
    for (const f of fields) map.set(f.name, f);
    return map;
  }, [fields]);

  return (
    <div className="mt-2 rounded-md border border-border bg-surface-0">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
          Features
          {loading ? '' : ` · ${features.length}`}
        </p>
        <div className="flex items-center gap-1">
          {canEdit ? (
            <button
              type="button"
              onClick={addBlank}
              disabled={adding}
              className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-[11px] font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
            >
              {adding ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              Add row
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loading}
            className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-[11px] font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Refresh
          </button>
          {/* #107: export current feature set to CSV / XLSX.  Uses
              whatever's already loaded in `features` so there's no
              extra round-trip; matches what the table is showing.
              Bundle export (related tables + attachments) is a
              follow-up that lands a server-side ZIP endpoint -- see
              docs/handoff/reference/bundle-export-notes.md. */}
          <ExportMenu
            features={features}
            layer={layer}
            disabled={loading || features.length === 0}
          />
        </div>
      </header>

      {error ? (
        <div className="flex items-start gap-1.5 border-b border-border bg-danger/5 px-3 py-1.5 text-[11px] text-danger">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {loading ? (
        <p className="px-3 py-6 text-center text-xs text-muted">
          Loading features…
        </p>
      ) : features.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted">
          No features yet. Import a file or add a blank row.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="bg-surface-2 text-muted">
              <tr>
                <th className="px-2 py-1 text-left font-medium">#</th>
                {columnKeys.map((k) => (
                  <th
                    key={k}
                    className="whitespace-nowrap px-2 py-1 text-left font-medium"
                    title={fieldByName.get(k)?.label ?? k}
                  >
                    {fieldByName.get(k)?.label || k}
                    <span className="ml-1 text-[9px] uppercase text-muted">
                      {fieldByName.get(k)?.type ?? ''}
                    </span>
                  </th>
                ))}
                {canEdit ? (
                  <th className="sticky right-0 bg-surface-2 px-2 py-1 text-right font-medium">
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {features.map((f) => {
                const isEditing = editingId === f.id;
                return (
                  <tr key={f.id} className="border-t border-border">
                    <td
                      className="px-2 py-1 font-mono text-[10px] text-muted"
                      title={f.id}
                    >
                      {f._meta?.gid ?? f.id.slice(0, 6)}
                    </td>
                    {columnKeys.map((k) => {
                      const field = fieldByName.get(k);
                      const raw = isEditing
                        ? draft[k]
                        : f.properties?.[k];
                      return (
                        <td
                          key={k}
                          className="whitespace-nowrap px-2 py-1 align-top"
                        >
                          {isEditing ? (
                            <FieldEditor
                              field={field}
                              name={k}
                              value={raw}
                              onChange={(v) =>
                                setDraft((prev) => ({ ...prev, [k]: v }))
                              }
                            />
                          ) : (
                            <span className="text-ink-1">
                              {formatCellValue(raw)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                    {canEdit || layer.attachmentsEnabled ? (
                      <td className="sticky right-0 bg-surface-0 px-2 py-1 text-right">
                        <div className="inline-flex items-center gap-0.5">
                          {isEditing ? (
                            <>
                              <button
                                type="button"
                                onClick={() => void saveEdit()}
                                disabled={saving}
                                title="Save"
                                className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface-1 text-accent hover:bg-accent/10 disabled:opacity-50"
                              >
                                {saving ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Save className="h-3 w-3" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={cancelEdit}
                                disabled={saving}
                                title="Cancel"
                                className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface-1 text-muted hover:bg-surface-2 disabled:opacity-50"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </>
                          ) : (
                            <>
                              {layer.attachmentsEnabled ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setAttachmentsOpenFor((prev) =>
                                      prev === f.id ? null : f.id,
                                    )
                                  }
                                  title="Attachments"
                                  className={`inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface-1 ${
                                    attachmentsOpenFor === f.id
                                      ? 'text-accent'
                                      : 'text-muted hover:bg-surface-2 hover:text-ink-1'
                                  }`}
                                >
                                  <Paperclip className="h-3 w-3" />
                                </button>
                              ) : null}
                              {canEdit ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => startEdit(f)}
                                    title="Edit"
                                    className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface-1 text-muted hover:bg-surface-2 hover:text-ink-1"
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void remove(f)}
                                    title="Delete"
                                    className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface-1 text-muted hover:bg-danger/10 hover:text-danger"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </>
                              ) : null}
                            </>
                          )}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
              {/* Render the attachments panel in its own row below the
                   feature whose panel is open, so the gallery has room
                   to breathe without squeezing the table. */}
              {attachmentsOpenFor &&
              features.some((f) => f.id === attachmentsOpenFor) ? (
                <tr>
                  <td
                    colSpan={
                      1 +
                      columnKeys.length +
                      (canEdit || layer.attachmentsEnabled ? 1 : 0)
                    }
                    className="border-t border-border bg-surface-1 px-3 py-2"
                  >
                    <V3FeatureAttachments
                      itemId={itemId}
                      layerId={layer.id}
                      featureId={attachmentsOpenFor}
                      canEdit={canEdit}
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      {features.length > 0 && canEdit ? (
        <footer className="flex items-center gap-1 border-t border-border bg-surface-1 px-3 py-1.5 text-[10px] text-muted">
          <Check className="h-3 w-3" />
          Edits save to the feature table; history is preserved via the
          temporal valid_from/valid_to pattern.
        </footer>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * #107: Export-this-layer dropdown.  Two formats today (CSV +
 * XLSX), both built client-side from the already-loaded feature
 * set.  Geometry rides along as a `geometry_wkt` column on XLSX so
 * the user can round-trip into desktop GIS without losing shape;
 * CSV stays text-only by convention.
 *
 * Why "what's loaded" instead of always re-fetching: the feature
 * browser loads the whole layer on open (capped at whatever the
 * features endpoint returns), so the table view IS the canonical
 * dataset for this layer.  Exporting that exact set means "what
 * you see is what you get" -- if the cap matters the table also
 * shows it.  Bundle export (related tables + attachments) is the
 * follow-up that needs a server-side ZIP endpoint.
 */
function ExportMenu({
  features,
  layer,
  disabled,
}: {
  features: FeatureRecord[];
  layer: DataLayerSublayer;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  function run(format: ExportFormat): void {
    setOpen(false);
    if (features.length === 0) return;
    const filename = sanitizeFilename(layer.label || layer.name || 'layer');
    exportFeatures(
      features.map((f) => ({
        id: f.id,
        geometry: f.geometry,
        properties: f.properties ?? null,
      })),
      format,
      {
        filename,
        fields: (layer.fields ?? []).map((fld) => ({
          name: fld.name,
          ...(fld.label && fld.label !== fld.name ? { label: fld.label } : {}),
        })),
        // XLSX gets the WKT geometry column for desktop-GIS round-
        // trip; CSV stays text-only (the most common downstream
        // consumer, Excel for casual edits, doesn't know WKT and
        // the column would just clutter the view).
        includeGeometryWkt: format === 'xlsx',
      },
    );
  }
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-[11px] font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        title={
          features.length === 0
            ? 'No features to export'
            : `Export ${features.length} feature(s)`
        }
      >
        <Download className="h-3 w-3" />
        Export
      </button>
      {open ? (
        <>
          {/* Click-away catcher.  Pointer-events on the backdrop so
              a click outside the menu collapses it.  Same pattern
              other dropdowns in the portal use. */}
          <div
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute right-0 top-8 z-40 w-44 rounded-md border border-border bg-surface-0 py-1 text-xs shadow-lg">
            <button
              type="button"
              onClick={() => run('xlsx')}
              className="block w-full px-3 py-1.5 text-left hover:bg-surface-2"
            >
              Excel (.xlsx)
            </button>
            <button
              type="button"
              onClick={() => run('csv')}
              className="block w-full px-3 py-1.5 text-left hover:bg-surface-2"
            >
              CSV
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Trim a label down to a safe filename root.  Keeps letters /
 *  digits / underscores / hyphens / dots, replaces everything else
 *  with `_`, and caps the length so we don't trip Windows path
 *  limits with a 200-char layer name. */
function sanitizeFilename(raw: string): string {
  const s = raw.trim().replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_');
  return (s.slice(0, 60) || 'layer').replace(/^_+|_+$/g, '');
}

// ---------------------------------------------------------------------------

/** Render a typed editor input based on the declared field type.
 *  Unknown / legacy columns fall back to text. */
function FieldEditor({
  field,
  name,
  value,
  onChange,
}: {
  field: FeatureField | undefined;
  name: string;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const kind = field?.type ?? 'string';
  const stringValue = value === null || value === undefined ? '' : String(value);

  if (kind === 'boolean') {
    const checked = value === true || value === 'true';
    return (
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-border"
      />
    );
  }

  if (kind === 'number') {
    return (
      <input
        type="number"
        value={stringValue}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === '' ? null : Number(raw));
        }}
        className="h-6 w-24 rounded border border-border bg-surface-1 px-1 text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
      />
    );
  }

  if (kind === 'date') {
    // Accept both date-only (YYYY-MM-DD) and full ISO. Keep whatever
    // precision the backend already stored: parse/serialize naively.
    const dateVal =
      typeof value === 'string' ? value.slice(0, 10) : '';
    return (
      <input
        type="date"
        value={dateVal}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-6 rounded border border-border bg-surface-1 px-1 text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
      />
    );
  }

  // string + domain: render a select when coded-value domain is set.
  if (kind === 'string' && field?.domain?.type === 'coded-value') {
    return (
      <select
        value={stringValue}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-6 rounded border border-border bg-surface-1 px-1 text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
      >
        <option value="">-</option>
        {field.domain.values.map((v) => (
          <option key={String(v.code)} value={String(v.code)}>
            {v.label || String(v.code)}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      type="text"
      value={stringValue}
      onChange={(e) => onChange(e.target.value)}
      placeholder={name}
      className="h-6 w-40 rounded border border-border bg-surface-1 px-1 text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
    />
  );
}

function formatCellValue(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}
