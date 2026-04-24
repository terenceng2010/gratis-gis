'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Loader2, MapPin, Save, Trash2 } from 'lucide-react';

/**
 * Per-share "Restrict to area" editor.
 *
 * Shown from the sharing panel's row action menu. Lets an admin
 * associate a GeoJSON polygon with a share — after save, that
 * principal only sees features whose geometry intersects the polygon
 * (and items whose bbox does).
 *
 * Two input paths:
 *   - Paste a GeoJSON Polygon / MultiPolygon / Feature / FeatureCollection
 *   - Enter a bounding box (minLng, minLat, maxLng, maxLat) and we
 *     synthesize a rectangular polygon from it
 *
 * A proper map-based polygon drawing tool is on the follow-up list;
 * this text-first UI is enough to validate the model end-to-end and
 * authors are almost always pasting existing regional boundaries
 * anyway.
 */
interface Props {
  principalLabel: string;
  initialGeoLimit: unknown | null;
  saving: boolean;
  onSave: (geoLimit: unknown | null) => Promise<void> | void;
  onClose: () => void;
}

type Mode = 'geojson' | 'bbox';

export function ShareGeoLimitDialog({
  principalLabel,
  initialGeoLimit,
  saving,
  onSave,
  onClose,
}: Props) {
  const [mode, setMode] = useState<Mode>('geojson');
  const [text, setText] = useState(() =>
    initialGeoLimit ? JSON.stringify(initialGeoLimit, null, 2) : '',
  );
  const [minLng, setMinLng] = useState('');
  const [minLat, setMinLat] = useState('');
  const [maxLng, setMaxLng] = useState('');
  const [maxLat, setMaxLat] = useState('');
  const [error, setError] = useState<string | null>(null);

  const hasExisting = initialGeoLimit !== null && initialGeoLimit !== undefined;

  // Parse and validate whatever the user has in the active input.
  const validated = useMemo<
    | { ok: true; geometry: unknown; summary: string }
    | { ok: false; error: string }
    | null
  >(() => {
    if (mode === 'geojson') {
      if (!text.trim()) return null;
      try {
        const parsed = JSON.parse(text) as unknown;
        const geom = toGeometry(parsed);
        if (!geom) {
          return {
            ok: false,
            error:
              'Expected a GeoJSON Polygon, MultiPolygon, Feature, or FeatureCollection containing one.',
          };
        }
        return { ok: true, geometry: geom, summary: describeGeometry(geom) };
      } catch (err) {
        return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
      }
    }
    // bbox mode
    const parts = [minLng, minLat, maxLng, maxLat].map(Number);
    if (parts.some((n) => Number.isNaN(n))) return null;
    const [w, s, e, n] = parts as [number, number, number, number];
    if (w >= e || s >= n) {
      return {
        ok: false,
        error: 'min must be less than max on both axes.',
      };
    }
    if (w < -180 || e > 180 || s < -90 || n > 90) {
      return {
        ok: false,
        error: 'Coordinates must be valid WGS84 (lon ±180, lat ±90).',
      };
    }
    const polygon = {
      type: 'Polygon' as const,
      coordinates: [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ],
      ],
    };
    return {
      ok: true,
      geometry: polygon,
      summary: `Rectangle · ${(e - w).toFixed(3)}° × ${(n - s).toFixed(3)}°`,
    };
  }, [mode, text, minLng, minLat, maxLng, maxLat]);

  async function save() {
    setError(null);
    if (!validated) {
      setError('Enter a polygon or a bounding box.');
      return;
    }
    if (!validated.ok) {
      setError(validated.error);
      return;
    }
    await onSave(validated.geometry);
  }

  async function clear() {
    setError(null);
    await onSave(null);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl space-y-3 rounded-lg border border-border bg-surface-1 p-4 shadow-raised"
      >
        <div className="flex items-center gap-2">
          <MapPin className="h-5 w-5 text-accent" />
          <h2 className="text-lg font-semibold">Restrict to area</h2>
        </div>
        <p className="text-xs text-muted">
          Limit what{' '}
          <span className="font-medium text-ink-1">{principalLabel}</span>{' '}
          can see on this item to features within a polygon. Items whose
          bbox doesn&apos;t intersect are also hidden. Admins are exempt.
        </p>

        <div className="inline-flex rounded border border-border bg-surface-2 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setMode('geojson')}
            className={`rounded px-2 py-0.5 ${
              mode === 'geojson'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted hover:text-ink-1'
            }`}
          >
            GeoJSON
          </button>
          <button
            type="button"
            onClick={() => setMode('bbox')}
            className={`rounded px-2 py-0.5 ${
              mode === 'bbox'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted hover:text-ink-1'
            }`}
          >
            Bounding box
          </button>
        </div>

        {mode === 'geojson' ? (
          <div>
            <label className="block text-xs">
              <span className="mb-1 block uppercase tracking-wide text-muted">
                Paste GeoJSON
              </span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={10}
                placeholder={`{\n  "type": "Polygon",\n  "coordinates": [[[lng,lat], ...]]\n}`}
                className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 font-mono text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
            </label>
            <p className="mt-1 text-[11px] text-muted">
              Accepts a Polygon, MultiPolygon, Feature, or FeatureCollection.
              EPSG:4326 coordinates (lng, lat).
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <BBoxField label="Min lng (west)" value={minLng} onChange={setMinLng} />
            <BBoxField label="Min lat (south)" value={minLat} onChange={setMinLat} />
            <BBoxField label="Max lng (east)" value={maxLng} onChange={setMaxLng} />
            <BBoxField label="Max lat (north)" value={maxLat} onChange={setMaxLat} />
          </div>
        )}

        {validated?.ok ? (
          <div className="rounded border border-success/30 bg-success/5 px-2 py-1 text-[11px] text-success">
            <Check className="mr-1 inline h-3 w-3" />
            {validated.summary}
          </div>
        ) : null}

        {error || (validated && !validated.ok) ? (
          <div
            role="alert"
            className="flex items-start gap-1.5 rounded border border-danger/30 bg-danger/5 px-2 py-1 text-[11px] text-danger"
          >
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{error ?? (validated && !validated.ok ? validated.error : '')}</span>
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2 pt-1">
          {hasExisting ? (
            <button
              type="button"
              onClick={clear}
              disabled={saving}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-danger hover:bg-danger/5 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear restriction
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="h-9 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || !validated || !validated.ok}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BBoxField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block uppercase tracking-wide text-muted">
        {label}
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full rounded-md border border-border bg-surface-1 px-2 font-mono text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
      />
    </label>
  );
}

/**
 * Unwrap a GeoJSON value into a bare geometry. Accepts:
 *   - Polygon / MultiPolygon geometry directly
 *   - Feature with such a geometry
 *   - FeatureCollection with one or more polygon features (unioned
 *     into a MultiPolygon at the call site — today we just pull the
 *     first feature's geometry if there's exactly one, otherwise
 *     reject with a clear message)
 */
function toGeometry(v: unknown): unknown | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { type?: string; geometry?: unknown; features?: unknown[] };
  if (o.type === 'Polygon' || o.type === 'MultiPolygon') return o;
  if (o.type === 'Feature' && o.geometry) {
    return toGeometry(o.geometry);
  }
  if (o.type === 'FeatureCollection' && Array.isArray(o.features)) {
    const geoms = o.features
      .map((f) => (f && typeof f === 'object' ? (f as { geometry?: unknown }).geometry : null))
      .filter((g): g is object => !!g)
      .map((g) => toGeometry(g))
      .filter((g): g is object => !!g);
    if (geoms.length === 0) return null;
    if (geoms.length === 1) return geoms[0];
    return {
      type: 'GeometryCollection',
      geometries: geoms,
    };
  }
  return null;
}

function describeGeometry(g: unknown): string {
  if (!g || typeof g !== 'object') return '';
  const o = g as { type?: string; coordinates?: unknown; geometries?: unknown[] };
  if (o.type === 'Polygon' && Array.isArray(o.coordinates)) {
    const rings = o.coordinates.length;
    const first = (o.coordinates[0] as unknown[] | undefined)?.length ?? 0;
    return `Polygon · ${rings} ring${rings === 1 ? '' : 's'} · ${first} vertices`;
  }
  if (o.type === 'MultiPolygon' && Array.isArray(o.coordinates)) {
    return `MultiPolygon · ${o.coordinates.length} part${
      o.coordinates.length === 1 ? '' : 's'
    }`;
  }
  if (o.type === 'GeometryCollection' && Array.isArray(o.geometries)) {
    return `GeometryCollection · ${o.geometries.length} geometries`;
  }
  return o.type ?? 'geometry';
}
