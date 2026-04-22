'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClipboardPaste,
  Database,
  Globe,
  Link2,
  Loader2,
  Search,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import type { Item, WebMapLayer, WebMapLayerSource } from '@gratis-gis/shared-types';
import {
  DEFAULT_LAYER_LABELS,
  DEFAULT_LAYER_SEARCH,
  DEFAULT_LAYER_STYLE,
  DEFAULT_LAYER_POPUP,
  DEFAULT_LAYER_INTERACTIONS,
  DEFAULT_LAYER_RENDERER,
} from '@gratis-gis/shared-types';
import { CURATED_SOURCES, type CuratedSource } from './curated-sources';
import { fileToGeoJson } from './kml-convert';

interface Props {
  open: boolean;
  onClose: () => void;
  onAdd: (layer: WebMapLayer) => void;
}

type Tab = 'url' | 'paste' | 'file' | 'portal' | 'curated';

/**
 * Four-tab layer catalog:
 *   1. URL — paste a GeoJSON URL and go.
 *   2. Paste — drop inline GeoJSON for tiny datasets.
 *   3. Portal — feature_service items from this portal.
 *   4. Curated — hand-picked, well-maintained public datasets.
 *
 * The dialog itself stays stateless about which source wins: it builds a
 * WebMapLayer and fires onAdd, the parent decides what to do with it.
 */
export function AddLayerDialog({ open, onClose, onAdd }: Props) {
  const [tab, setTab] = useState<Tab>('url');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [paste, setPaste] = useState('');
  const [fileBusy, setFileBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Portal tab state: list of feature_service items + search query.
  const [portalQ, setPortalQ] = useState('');
  const [portalItems, setPortalItems] = useState<Item[]>([]);
  const [portalLoading, setPortalLoading] = useState(false);

  // Curated tab state: search narrows the curated list.
  const [curatedQ, setCuratedQ] = useState('');

  const reset = useCallback(() => {
    setTab('url');
    setTitle('');
    setUrl('');
    setPaste('');
    setPortalQ('');
    setCuratedQ('');
    setError(null);
  }, []);

  // Load portal items when the portal tab activates or the query changes.
  useEffect(() => {
    if (!open || tab !== 'portal') return;
    let cancelled = false;
    setPortalLoading(true);
    const handle = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ type: 'feature_service' });
        if (portalQ.trim()) qs.set('q', portalQ.trim());
        const res = await fetch(`/api/portal/items?${qs}`);
        if (!res.ok) return;
        const items = (await res.json()) as Item[];
        if (!cancelled) setPortalItems(items);
      } finally {
        if (!cancelled) setPortalLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, tab, portalQ]);

  const filteredCurated = useMemo(() => {
    const q = curatedQ.trim().toLowerCase();
    if (!q) return CURATED_SOURCES;
    return CURATED_SOURCES.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [curatedQ]);

  function makeLayer(title: string, source: WebMapLayerSource): WebMapLayer {
    return {
      id: crypto.randomUUID(),
      title,
      visible: true,
      opacity: 1,
      source,
      style: structuredClone(DEFAULT_LAYER_STYLE),
      renderer: structuredClone(DEFAULT_LAYER_RENDERER),
      popup: structuredClone(DEFAULT_LAYER_POPUP),
      interactions: structuredClone(DEFAULT_LAYER_INTERACTIONS),
      labels: structuredClone(DEFAULT_LAYER_LABELS),
      search: structuredClone(DEFAULT_LAYER_SEARCH),
      filter: null,
    };
  }

  function submitUrlOrPaste() {
    setError(null);
    if (!title.trim()) {
      setError('Give the layer a name so it shows up in the list.');
      return;
    }
    let source: WebMapLayerSource;
    if (tab === 'url') {
      if (!url.trim()) {
        setError('Paste a GeoJSON URL.');
        return;
      }
      source = { kind: 'geojson-url', url: url.trim() };
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(paste);
      } catch {
        setError('That is not valid JSON. Check for a missing brace or quote.');
        return;
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        (parsed as { type?: string }).type !== 'FeatureCollection'
      ) {
        setError('Paste a GeoJSON FeatureCollection (not a bare Feature or geometry).');
        return;
      }
      source = { kind: 'geojson-inline', geojson: parsed };
    }
    onAdd(makeLayer(title.trim(), source));
    reset();
    onClose();
  }

  function submitPortalItem(item: Item) {
    onAdd(
      makeLayer(item.title, { kind: 'feature-service', itemId: item.id }),
    );
    reset();
    onClose();
  }

  /**
   * File-upload handler for GeoJSON / KML / KMZ. Reads the file entirely
   * in-browser, converts to a GeoJSON FeatureCollection, and stores it
   * inline on the new layer. Inline is fine up to a few hundred KB;
   * larger datasets should be brought in through the feature-service
   * pillar once that stores data server-side.
   */
  async function submitFile(file: File) {
    setError(null);
    setFileBusy(true);
    try {
      const lname = file.name.toLowerCase();
      let geojson: GeoJSON.FeatureCollection;
      if (lname.endsWith('.geojson') || lname.endsWith('.json')) {
        const text = await file.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          setError('That file is not valid JSON.');
          return;
        }
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          (parsed as { type?: string }).type !== 'FeatureCollection'
        ) {
          setError('Top-level object must be a GeoJSON FeatureCollection.');
          return;
        }
        geojson = parsed as GeoJSON.FeatureCollection;
      } else {
        geojson = await fileToGeoJson(file);
      }
      const derivedTitle =
        title.trim() || file.name.replace(/\.[^.]+$/, '');
      onAdd(
        makeLayer(derivedTitle, {
          kind: 'geojson-inline',
          geojson,
        }),
      );
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read file.');
    } finally {
      setFileBusy(false);
    }
  }

  function submitCurated(src: CuratedSource) {
    onAdd(
      makeLayer(src.title, { kind: 'geojson-url', url: src.url }),
    );
    reset();
    onClose();
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add layer"
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold">Add layer</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex gap-0 border-b border-border px-2 pt-2">
          <TabButton Icon={Link2} label="URL" active={tab === 'url'} onClick={() => setTab('url')} />
          <TabButton
            Icon={Upload}
            label="File"
            active={tab === 'file'}
            onClick={() => setTab('file')}
          />
          <TabButton
            Icon={ClipboardPaste}
            label="Paste"
            active={tab === 'paste'}
            onClick={() => setTab('paste')}
          />
          <TabButton
            Icon={Database}
            label="Portal"
            active={tab === 'portal'}
            onClick={() => setTab('portal')}
          />
          <TabButton
            Icon={Globe}
            label="Curated"
            active={tab === 'curated'}
            onClick={() => setTab('curated')}
          />
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {(tab === 'url' || tab === 'paste') && (
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                  Name
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Parcels, roads, observations..."
                  maxLength={200}
                  className="h-9 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </div>
              {tab === 'url' ? (
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                    GeoJSON URL
                  </label>
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://example.org/parcels.geojson"
                    className="h-9 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                  <p className="mt-1 text-xs text-muted">
                    Must be reachable from a browser (CORS-enabled) and return
                    a GeoJSON FeatureCollection.
                  </p>
                </div>
              ) : (
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                    GeoJSON
                  </label>
                  <textarea
                    value={paste}
                    onChange={(e) => setPaste(e.target.value)}
                    placeholder='{"type":"FeatureCollection","features":[...]}'
                    rows={10}
                    className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                  <p className="mt-1 text-xs text-muted">
                    Small datasets only. Inline features are stored in the item
                    itself; for anything over a few hundred rows use a URL.
                  </p>
                </div>
              )}
            </div>
          )}

          {tab === 'file' && (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                  Name
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Optional. Defaults to the filename."
                  maxLength={200}
                  className="h-9 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </div>
              <FileDropZone
                busy={fileBusy}
                onFile={submitFile}
                accept=".kml,.kmz,.geojson,.json,.zip,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/geo+json,application/json,application/zip"
              />
              <p className="text-[11px] text-muted">
                Accepts GeoJSON, KML, KMZ, and zipped Shapefiles. Files are
                parsed in your browser and stored inline on the layer;
                keep them under a few hundred KB. For larger datasets,
                ingest as a feature service instead.
              </p>
            </div>
          )}

          {tab === 'portal' && (
            <div className="space-y-3">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  type="text"
                  value={portalQ}
                  onChange={(e) => setPortalQ(e.target.value)}
                  placeholder="Search feature services..."
                  className="h-9 w-full rounded-md border border-border bg-surface-1 pl-9 pr-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </label>
              {portalLoading ? (
                <p className="text-xs text-muted">Searching...</p>
              ) : portalItems.length === 0 ? (
                <div className="rounded-md border border-border bg-surface-2 p-4 text-center text-xs text-muted">
                  <Sparkles className="mx-auto mb-2 h-5 w-5" />
                  No feature services match. Once you upload vector data as a
                  feature service, it will show up here.
                </div>
              ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-1">
                  {portalItems.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => submitPortalItem(item)}
                        className="flex w-full flex-col items-start gap-1 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
                      >
                        <div className="truncate text-sm font-medium text-ink-0">
                          {item.title}
                        </div>
                        {item.description ? (
                          <div className="line-clamp-1 text-xs text-muted">
                            {item.description}
                          </div>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-muted">
                Feature services will fully render on the map once that pillar
                ships. Saving the reference now means switching to it later is
                a one-line update.
              </p>
            </div>
          )}

          {tab === 'curated' && (
            <div className="space-y-3">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  type="text"
                  value={curatedQ}
                  onChange={(e) => setCuratedQ(e.target.value)}
                  placeholder="Search curated datasets..."
                  className="h-9 w-full rounded-md border border-border bg-surface-1 pl-9 pr-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </label>
              <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-1">
                {filteredCurated.map((src) => (
                  <li key={src.url}>
                    <button
                      type="button"
                      onClick={() => submitCurated(src)}
                      className="flex w-full flex-col items-start gap-1 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
                    >
                      <div className="flex w-full items-center justify-between gap-3">
                        <span className="truncate text-sm font-medium text-ink-0">
                          {src.title}
                        </span>
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
                          {src.category}
                        </span>
                      </div>
                      <div className="line-clamp-2 text-xs text-muted">
                        {src.description}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {src.tags.map((t) => (
                          <span
                            key={t}
                            className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              {filteredCurated.length === 0 ? (
                <p className="text-xs text-muted">No datasets match.</p>
              ) : null}
              <p className="text-[11px] text-muted">
                Links point to public, permissively-licensed data. Attribution
                is the responsibility of the map author.
              </p>
            </div>
          )}

          {error ? (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>

        {(tab === 'url' || tab === 'paste') && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-md border border-border bg-surface-1 px-3 text-sm text-ink-1 hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitUrlOrPaste}
              className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
            >
              Add layer
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FileDropZone({
  busy,
  accept,
  onFile,
}: {
  busy: boolean;
  accept: string;
  onFile: (file: File) => void;
}) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      className={`flex min-h-[120px] flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 text-center transition-colors ${
        over ? 'border-accent bg-accent/5' : 'border-border bg-surface-1'
      } ${busy ? 'pointer-events-none opacity-60' : ''}`}
    >
      {busy ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted" />
      ) : (
        <Upload className="h-5 w-5 text-muted" />
      )}
      <p className="text-sm text-ink-1">
        {busy ? 'Reading file...' : 'Drop a file here'}
      </p>
      <p className="text-xs text-muted">or</p>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="inline-flex h-8 items-center rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
      >
        Choose file
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function TabButton({
  Icon,
  label,
  active,
  onClick,
}: {
  Icon: typeof Link2;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
        active
          ? 'border-accent text-ink-0'
          : 'border-transparent text-muted hover:text-ink-1'
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}
