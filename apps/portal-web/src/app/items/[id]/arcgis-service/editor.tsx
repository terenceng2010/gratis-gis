'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  ExternalLink,
  Loader2,
  RefreshCw,
  Save,
  Search,
} from 'lucide-react';
import type { ArcgisServiceData, ISODateString } from '@gratis-gis/shared-types';
import {
  DEFAULT_ARCGIS_SERVICE,
} from '@gratis-gis/shared-types';
import {
  probeService,
  type ArcgisServiceDescription,
} from '@/lib/arcgis-rest';

interface Props {
  itemId: string;
  initial: ArcgisServiceData;
  canEdit: boolean;
}

/**
 * Detail-page editor for an arcgis_service item. Owns the item's
 * dataJson: the service URL, service type, default sublayer, and the
 * snapshot of sublayers that the Add Layer picker reads. Users can
 * paste a URL and probe the service; probe results are staged and
 * saved together so the item's data is always internally consistent
 * (url, serviceType, and layer list all come from the same probe).
 *
 * No feature payload lives here — arcgis_service is a live pointer,
 * so the runtime (web-map viewer) is what actually calls the service.
 */
export function ArcgisServiceEditor({ itemId, initial, canEdit }: Props) {
  const router = useRouter();
  const [data, setData] = useState<ArcgisServiceData>({
    ...DEFAULT_ARCGIS_SERVICE,
    ...initial,
  });
  const [urlDraft, setUrlDraft] = useState(data.url);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] =
    useState<ArcgisServiceDescription | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const abortRef = useRef<AbortController | null>(null);

  // The "staged" view merges existing saved values with whatever the
  // probe returned. Once the user commits via Save, staged becomes
  // data and the probe result is cleared.
  const stagedDefault = (() => {
    if (!probeResult) return data.defaultLayerId;
    if (
      data.defaultLayerId != null &&
      probeResult.layers.some((l) => l.id === data.defaultLayerId)
    ) {
      return data.defaultLayerId;
    }
    const firstGeom = probeResult.layers.find((l) => l.geometryType);
    return firstGeom?.id ?? probeResult.layers[0]?.id;
  })();
  const staged: ArcgisServiceData = probeResult
    ? {
        ...data,
        url: probeResult.url,
        serviceType: probeResult.serviceType,
        layers: probeResult.layers.map((l) => {
          const base: { id: number; name: string; geometryType?: string } = {
            id: l.id,
            name: l.name,
          };
          if (l.geometryType) base.geometryType = l.geometryType;
          return base;
        }),
        ...(probeResult.bbox ? { bbox: probeResult.bbox } : {}),
        // defaultLayerId only included when resolved — the shared
        // type has it as optional, and exactOptionalPropertyTypes
        // means we need to omit rather than pass `undefined`.
        ...(stagedDefault !== undefined
          ? { defaultLayerId: stagedDefault }
          : {}),
        probedAt: new Date().toISOString() as ISODateString,
      }
    : data;

  const hasChanges =
    probeResult !== null ||
    staged.defaultLayerId !== data.defaultLayerId ||
    staged.url !== data.url;

  const runProbe = useCallback(async () => {
    const raw = urlDraft.trim();
    if (!raw) {
      setError('Paste an ArcGIS MapServer or FeatureServer URL.');
      return;
    }
    setError(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setProbing(true);
    try {
      const desc = await probeService(raw, controller.signal);
      if (controller.signal.aborted) return;
      setProbeResult(desc);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setError(
        (err as Error).message ||
          'Could not read that service. Check the URL and CORS config.',
      );
    } finally {
      if (!controller.signal.aborted) setProbing(false);
    }
  }, [urlDraft]);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: staged }),
      });
      if (!res.ok) {
        setError(`Save failed: ${res.status} ${await res.text()}`);
        return;
      }
      setData(staged);
      setProbeResult(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      startTransition(() => router.refresh());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div id="configure-arcgis" className="space-y-5">
      <div className="rounded-lg border border-border bg-surface-1 p-4">
        <h3 className="mb-1 text-sm font-semibold">Service endpoint</h3>
        <p className="mb-3 text-xs text-muted">
          Paste the service root (<code>.../MapServer</code> or{' '}
          <code>.../FeatureServer</code>) or a specific layer URL. The
          viewer queries features live by bbox as authors pan and zoom.
        </p>
        <div className="flex gap-2">
          <input
            type="url"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void runProbe();
              }
            }}
            disabled={!canEdit}
            placeholder="https://host/arcgis/rest/services/OpenData/Assessor/MapServer"
            className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => void runProbe()}
            disabled={!canEdit || probing || !urlDraft.trim()}
            className="inline-flex h-9 items-center gap-1 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            {probing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            Probe
          </button>
        </div>
        {data.url && !probeResult ? (
          <p className="mt-3 flex items-center gap-1 text-xs text-muted">
            <ExternalLink className="h-3 w-3" />
            <a
              href={`${data.url}?f=html`}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-ink-1"
            >
              Open the service page
            </a>
            <span className="mx-1">•</span>
            {data.serviceType}
            {data.probedAt ? (
              <>
                <span className="mx-1">•</span>
                last probed {formatDate(data.probedAt)}
              </>
            ) : null}
          </p>
        ) : null}
      </div>

      {staged.layers.length > 0 ? (
        <div className="rounded-lg border border-border bg-surface-1 p-4">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">
                Default sublayer
              </h3>
              <p className="text-xs text-muted">
                Maps that pick this item from Portal load this layer by
                default. Authors can override per-map.
              </p>
            </div>
            {probeResult ? (
              <button
                type="button"
                onClick={() => setProbeResult(null)}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-[11px] text-muted hover:bg-surface-2"
                title="Discard probe result"
              >
                <RefreshCw className="h-3 w-3" />
                Discard probe
              </button>
            ) : null}
          </div>
          <ul className="max-h-72 space-y-0.5 overflow-y-auto rounded border border-border bg-surface-0 p-1">
            {staged.layers.map((l) => {
              const active = l.id === staged.defaultLayerId;
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => {
                      // If we're editing against the live (unsaved)
                      // probe result, update it; otherwise update the
                      // persisted data directly so Save can pick it up.
                      if (probeResult) {
                        setProbeResult({
                          ...probeResult,
                          // Preserve the rest; defaultLayerId lives on
                          // the merged view, not probeResult itself.
                        });
                        setData((prev) => ({ ...prev, defaultLayerId: l.id }));
                      } else {
                        setData((prev) => ({ ...prev, defaultLayerId: l.id }));
                      }
                    }}
                    disabled={!canEdit}
                    className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                      active
                        ? 'bg-accent/10 text-ink-0 ring-1 ring-accent/40'
                        : 'text-ink-1 hover:bg-surface-2'
                    }`}
                  >
                    <span className="truncate">
                      <span className="tabular-nums text-muted">{l.id}</span>{' '}
                      {l.name}
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
                      {geometryShort(l.geometryType)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {canEdit ? (
        <div className="flex items-center justify-end gap-2">
          {saved ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" /> Saved
            </span>
          ) : null}
          <button
            type="button"
            onClick={save}
            disabled={saving || !hasChanges}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </button>
        </div>
      ) : null}
    </div>
  );
}

function geometryShort(g?: string): string {
  if (!g) return 'table';
  const m = g.match(/esriGeometry(\w+)/);
  return (m?.[1] ?? g).toLowerCase();
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}
