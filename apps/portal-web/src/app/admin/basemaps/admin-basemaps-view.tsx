'use client';

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Edit2,
  ExternalLink,
  Loader2,
  Map as MapIcon,
  Plus,
  Star,
  Trash2,
} from 'lucide-react';
import type { BasemapRow, BasemapSourceKind } from './page';

/**
 * Admin-side basemap library.
 *
 * Talks to /api/portal/basemaps (which proxies to the portal-api
 * BasemapsController, itself guarded by admin-only mutation logic).
 * Renders a table per source kind with inline CRUD. The "Add basemap"
 * button opens a small form that asks for the essentials; WMS rows
 * gain an extra textarea for per-layer config JSON when selected.
 */
interface Props {
  initialBasemaps: BasemapRow[];
}

const SOURCE_LABELS: Record<BasemapSourceKind, string> = {
  xyz: 'XYZ raster',
  'vector-style': 'Vector style',
  wms: 'WMS',
};

export function AdminBasemapsView({ initialBasemaps }: Props) {
  const [rows, setRows] = useState<BasemapRow[]>(initialBasemaps);
  const [editing, setEditing] = useState<BasemapRow | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((c) => (c === msg ? null : c)), 2000);
  };

  const grouped = useMemo(() => {
    const g: Record<BasemapSourceKind, BasemapRow[]> = {
      xyz: [],
      'vector-style': [],
      wms: [],
    };
    for (const r of rows) g[r.sourceKind].push(r);
    return g;
  }, [rows]);

  async function saveBasemap(payload: Partial<BasemapRow>, id?: string) {
    setError(null);
    setBusy('save');
    const method = id ? 'PATCH' : 'POST';
    const url = id
      ? `/api/portal/basemaps/${id}`
      : `/api/portal/basemaps`;
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setBusy(null);
    if (!res.ok) {
      setError(`${method} failed: ${res.status} ${await res.text()}`);
      return false;
    }
    const saved = (await res.json()) as BasemapRow;
    // If this one became default, unflag the previous default in local
    // state so the UI matches the server's post-transaction view.
    setRows((prev) => {
      const without = prev.filter((r) => r.id !== saved.id);
      const next = saved.isDefault
        ? without.map((r) => ({ ...r, isDefault: false }))
        : without;
      return [...next, saved].sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        return a.label.localeCompare(b.label);
      });
    });
    flash(id ? `${saved.label} updated` : `${saved.label} added`);
    setFormOpen(false);
    setEditing(null);
    return true;
  }

  async function removeBasemap(row: BasemapRow) {
    if (!confirm(`Delete basemap "${row.label}"? This can't be undone.`)) return;
    setError(null);
    setBusy(row.id);
    const res = await fetch(`/api/portal/basemaps/${row.id}`, {
      method: 'DELETE',
    });
    setBusy(null);
    if (!res.ok) {
      setError(`Delete failed: ${res.status}`);
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    flash(`${row.label} deleted`);
  }

  async function setDefault(row: BasemapRow) {
    setError(null);
    setBusy(row.id);
    const res = await fetch(`/api/portal/basemaps/${row.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isDefault: true }),
    });
    setBusy(null);
    if (!res.ok) {
      setError(`Update failed: ${res.status}`);
      return;
    }
    setRows((prev) =>
      prev
        .map((r) => ({
          ...r,
          isDefault: r.id === row.id,
        }))
        .sort((a, b) => {
          if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
          return a.label.localeCompare(b.label);
        }),
    );
    flash(`${row.label} is now the default`);
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-muted">
          {rows.length === 0
            ? 'No custom basemaps yet. Add the first one below.'
            : `${rows.length} custom basemap${rows.length === 1 ? '' : 's'}.`}
        </p>
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Add basemap
        </button>
      </div>

      {error ? (
        <div
          role="alert"
          className="mb-3 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
      {toast ? (
        <div className="mb-3 inline-flex items-center gap-1 rounded-md border border-success/30 bg-success/10 px-2 py-1 text-xs text-success">
          <Check className="h-3.5 w-3.5" />
          {toast}
        </div>
      ) : null}

      {(['xyz', 'vector-style', 'wms'] as const).map((kind) => {
        const group = grouped[kind];
        if (group.length === 0) return null;
        return (
          <section key={kind} className="mb-5">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
              {SOURCE_LABELS[kind]}
            </h2>
            <div className="overflow-hidden rounded-lg border border-border bg-surface-1">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-xs text-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Label</th>
                    <th className="px-3 py-2 text-left font-medium">URL</th>
                    <th className="px-3 py-2 text-left font-medium">Attribution</th>
                    <th className="px-3 py-2 text-center font-medium">Default</th>
                    <th className="px-3 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {group.map((row) => (
                    <tr key={row.id} className="border-t border-border">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <MapIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
                          <div>
                            <p className="font-medium text-ink-0">{row.label}</p>
                            {row.description ? (
                              <p className="text-xs text-muted">
                                {row.description}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-muted">
                        <a
                          href={row.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 truncate hover:text-accent"
                          title={row.url}
                        >
                          <span className="truncate block max-w-[28ch]">
                            {row.url}
                          </span>
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </a>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted">
                        {row.attribution || (
                          <span className="italic text-muted">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {row.isDefault ? (
                          <span className="inline-flex items-center gap-1 rounded bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent">
                            <Star className="h-3 w-3 fill-current" />
                            Default
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void setDefault(row)}
                            disabled={busy === row.id}
                            className="inline-flex h-6 items-center gap-1 rounded border border-border bg-surface-1 px-1.5 text-[11px] text-muted hover:bg-surface-2 hover:text-ink-1 disabled:opacity-50"
                          >
                            Make default
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              setEditing(row);
                              setFormOpen(true);
                            }}
                            disabled={busy === row.id}
                            className="inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-surface-1 text-muted hover:bg-surface-2 hover:text-ink-1 disabled:opacity-50"
                            aria-label="Edit"
                          >
                            <Edit2 className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeBasemap(row)}
                            disabled={busy === row.id}
                            className="inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-surface-1 text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                            aria-label="Delete"
                          >
                            {busy === row.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3" />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      {formOpen ? (
        <BasemapFormDialog
          initial={editing}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onSave={saveBasemap}
          busy={busy === 'save'}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface FormProps {
  initial: BasemapRow | null;
  onClose: () => void;
  onSave: (payload: Partial<BasemapRow>, id?: string) => Promise<boolean>;
  busy: boolean;
}

function BasemapFormDialog({ initial, onClose, onSave, busy }: FormProps) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [sourceKind, setSourceKind] = useState<BasemapSourceKind>(
    initial?.sourceKind ?? 'xyz',
  );
  const [attribution, setAttribution] = useState(initial?.attribution ?? '');
  const [thumbnailUrl, setThumbnailUrl] = useState(initial?.thumbnailUrl ?? '');
  const [configText, setConfigText] = useState(
    initial?.config ? JSON.stringify(initial.config, null, 2) : '',
  );
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (label.trim().length === 0) {
      setFormError('Label is required.');
      return;
    }
    if (url.trim().length === 0) {
      setFormError('URL is required.');
      return;
    }

    let config: Record<string, unknown> | null = null;
    if (configText.trim().length > 0) {
      try {
        config = JSON.parse(configText) as Record<string, unknown>;
      } catch {
        setFormError('Config is not valid JSON.');
        return;
      }
    }

    const payload: Partial<BasemapRow> = {
      label: label.trim(),
      description: description.trim(),
      url: url.trim(),
      sourceKind,
      attribution: attribution.trim(),
      thumbnailUrl: thumbnailUrl.trim() ? thumbnailUrl.trim() : null,
      config,
      isDefault,
    };
    await onSave(payload, initial?.id);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="mt-16 w-full max-w-xl space-y-3 rounded-lg border border-border bg-surface-1 p-4 shadow-raised"
      >
        <h2 className="text-lg font-semibold">
          {initial ? 'Edit basemap' : 'Add basemap'}
        </h2>

        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            Label
          </span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            Description
          </span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="One line shown under the label in the picker"
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>

        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            Type
          </span>
          <select
            value={sourceKind}
            onChange={(e) =>
              setSourceKind(e.target.value as BasemapSourceKind)
            }
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            <option value="xyz">
              XYZ raster tiles — standard {'{z}/{x}/{y}'} template URL
            </option>
            <option value="vector-style">
              Vector style — MapLibre-compatible style.json URL
            </option>
            <option value="wms">WMS GetMap — tile-over-WMS</option>
          </select>
        </label>

        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            URL
          </span>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={
              sourceKind === 'xyz'
                ? 'https://tile.example.com/{z}/{x}/{y}.png'
                : sourceKind === 'vector-style'
                  ? 'https://example.com/styles/my-style.json'
                  : 'https://gis.example.com/wms?'
            }
            required
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 font-mono text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>

        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            Attribution
          </span>
          <input
            type="text"
            value={attribution}
            onChange={(e) => setAttribution(e.target.value)}
            placeholder="© Data provider"
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>

        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            Thumbnail URL (optional)
          </span>
          <input
            type="url"
            value={thumbnailUrl}
            onChange={(e) => setThumbnailUrl(e.target.value)}
            placeholder="https://example.com/preview.png"
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>

        {sourceKind === 'wms' ? (
          <label className="block text-xs">
            <span className="mb-1 block uppercase tracking-wide text-muted">
              Config (WMS)
            </span>
            <textarea
              value={configText}
              onChange={(e) => setConfigText(e.target.value)}
              rows={4}
              placeholder={'{\n  "layers": "layer1,layer2",\n  "format": "image/png",\n  "transparent": true\n}'}
              className="w-full rounded-md border border-border bg-surface-1 px-2 py-1.5 font-mono text-[11px] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
            <p className="mt-1 text-[10px] text-muted">
              JSON with WMS extras (layers, format, transparent, version, styles, CRS).
            </p>
          </label>
        ) : null}

        <label className="inline-flex items-center gap-2 text-xs text-ink-1">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-border"
          />
          Make this the default basemap for new web maps
        </label>

        {formError ? (
          <p className="text-xs text-danger" role="alert">
            {formError}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            {initial ? 'Save changes' : 'Add basemap'}
          </button>
        </div>
      </form>
    </div>
  );
}
