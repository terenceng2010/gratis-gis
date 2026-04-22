'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  ClipboardPaste,
  FileArchive,
  Loader2,
  Save,
  Upload,
} from 'lucide-react';
import type {
  FeatureField,
  FeatureServiceData,
  ISODateString,
} from '@gratis-gis/shared-types';
import {
  detectFormat,
  importSpatialFile,
  type SpatialFormat,
  type SpatialImportResult,
} from '@/lib/spatial-import';

interface Props {
  itemId: string;
  initial: FeatureServiceData;
  canEdit: boolean;
}

type Tab = 'upload' | 'paste';

/**
 * Feature-service data editor. Supports two ways of replacing the
 * inline dataset:
 *
 *   - Upload: drag-drop or pick a file. Client-side parsers handle
 *     GeoJSON, KML, KMZ, and zipped Shapefiles; File Geodatabase is
 *     detected and gives a useful "coming soon" message.
 *   - Paste: raw GeoJSON FeatureCollection for small datasets.
 *
 * After parsing, a staged result is shown so the user can review the
 * feature count and detected fields before committing with Save.
 * Nothing hits the server until Save.
 */
export function FeatureServiceEditor({ itemId, initial, canEdit }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('upload');
  const [staged, setStaged] = useState<SpatialImportResult | null>(null);
  const [paste, setPaste] = useState('');
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentFeatures = initial.data.features ?? [];
  const currentFields = initial.fields;

  // Derived stats for the summary card; used as a fallback when the
  // persisted item has no declared fields yet.
  const derivedFields = useMemo<FeatureField[]>(
    () => deriveFields(currentFeatures, 500),
    [currentFeatures],
  );

  async function importFile(file: File) {
    setError(null);
    setStaged(null);
    setPending(true);
    try {
      // FGDB has no in-browser parser, so route it straight through
      // the server-side GDAL endpoint. Same for anything the client-
      // side parser rejects — caller can fall back to server ingest
      // from the error state.
      if (detectFormat(file.name) === 'fgdb') {
        await ingestServerSide(file);
        return;
      }
      const result = await importSpatialFile(file);
      setStaged(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setPending(false);
    }
  }

  /**
   * Hands a file to the portal-api's GDAL-backed ingest endpoint.
   * Unlike the client-side flow (stage → save), this commits in one
   * hop because the server already wrote the feature service back to
   * the database before responding.
   */
  async function ingestServerSide(file: File) {
    setError(null);
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/portal/items/${itemId}/ingest`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      setError(`Server ingest failed: ${res.status} ${text}`);
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    router.refresh();
  }

  function applyPaste() {
    setError(null);
    setStaged(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(paste);
    } catch {
      setError('That is not valid JSON.');
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
    const fc = parsed as GeoJSON.FeatureCollection;
    setStaged({
      geojson: fc,
      format: 'geojson',
      features: fc.features.length,
      warnings: [],
    });
  }

  async function save() {
    if (!staged) return;
    setError(null);
    setPending(true);
    try {
      const nextData: FeatureServiceData = {
        version: 1,
        fields: deriveFields(
          staged.geojson.features as Array<{
            properties?: Record<string, unknown>;
          }>,
          500,
        ),
        data: staged.geojson as FeatureServiceData['data'],
        updatedAt: new Date().toISOString() as ISODateString,
      };
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: nextData }),
      });
      if (!res.ok) {
        setError(`Save failed: ${res.status} ${await res.text()}`);
        return;
      }
      setStaged(null);
      setPaste('');
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  function discard() {
    setStaged(null);
    setPaste('');
    setError(null);
  }

  const isEmpty = currentFeatures.length === 0;

  return (
    <div className="space-y-6">
      {isEmpty ? (
        // Dominant empty-state. A fresh feature_service has no features
        // yet, so the page's primary job is to get data into it. The
        // stats card + "Replace data" framing is for the steady-state
        // case and doesn't match that first moment.
        <section className="rounded-lg border-2 border-dashed border-accent/40 bg-accent/5 p-5 text-center">
          <h3 className="text-base font-semibold text-ink-0">
            This feature service is empty
          </h3>
          <p className="mx-auto mt-1 max-w-xl text-sm text-muted">
            Upload a file or paste GeoJSON below to get started. Your
            fields, feature count, and last-updated time will appear
            here once there's data to summarize.
          </p>
        </section>
      ) : (
        <section className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
              Features
            </h3>
            <p className="mt-1 text-3xl font-semibold tabular-nums">
              {currentFeatures.length.toLocaleString()}
            </p>
            <p className="mt-1 text-xs text-muted">
              Last updated{' '}
              {initial.updatedAt
                ? new Date(initial.updatedAt).toLocaleString()
                : 'never'}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
              Fields
            </h3>
            <FieldChips
              fields={currentFields.length > 0 ? currentFields : derivedFields}
            />
          </div>
        </section>
      )}

      {canEdit ? (
        <section
          id="add-data"
          className="scroll-mt-20 rounded-lg border border-border bg-surface-1 shadow-card"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-sm font-medium">
              {isEmpty ? 'Add data' : 'Replace data'}
            </h3>
            <span className="text-[11px] text-muted">
              {isEmpty
                ? 'Upload a file, paste GeoJSON, or route a File Geodatabase through server-side GDAL.'
                : 'Whole-dataset replace. Incremental updates land later.'}
            </span>
          </div>

          <div className="flex gap-0 border-b border-border px-4 pt-2">
            <TabBtn
              Icon={Upload}
              label="Upload file"
              active={tab === 'upload'}
              onClick={() => setTab('upload')}
            />
            <TabBtn
              Icon={ClipboardPaste}
              label="Paste GeoJSON"
              active={tab === 'paste'}
              onClick={() => setTab('paste')}
            />
          </div>

          <div className="space-y-4 px-4 py-4">
            {tab === 'upload' ? (
              <>
                <FileDropZone busy={pending && !staged} onFile={importFile} />
                <div className="flex flex-wrap gap-1 text-[11px] text-muted">
                  <strong className="font-medium text-ink-1">Accepted:</strong>
                  <span>GeoJSON (.geojson/.json)</span>
                  <span>·</span>
                  <span>KML / KMZ</span>
                  <span>·</span>
                  <span>Shapefile (.zip bundle)</span>
                </div>
                <p className="text-[11px] text-muted">
                  Files are parsed in your browser. File Geodatabase
                  (.gdb) needs server-side GDAL which is planned but not
                  shipped — export to shapefile or GeoJSON from ArcGIS
                  Pro or QGIS for now.
                </p>
              </>
            ) : (
              <>
                <textarea
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  placeholder='{"type":"FeatureCollection","features":[...]}'
                  rows={10}
                  className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    onClick={applyPaste}
                    disabled={!paste.trim()}
                    className="h-8 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                  >
                    Stage for save
                  </button>
                </div>
              </>
            )}

            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}

            {staged ? (
              <StagedReview
                staged={staged}
                saving={pending}
                saved={saved}
                onSave={save}
                onDiscard={discard}
              />
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function StagedReview({
  staged,
  saving,
  saved,
  onSave,
  onDiscard,
}: {
  staged: SpatialImportResult;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const fields = useMemo(
    () =>
      deriveFields(
        staged.geojson.features as Array<{
          properties?: Record<string, unknown>;
        }>,
        500,
      ),
    [staged],
  );
  const label = formatLabel(staged.format);

  return (
    <div className="rounded-md border border-accent/30 bg-accent/5 p-3">
      <div className="flex items-start gap-3">
        <FileArchive className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            Ready to save: {label} &middot;{' '}
            <span className="tabular-nums">{staged.features.toLocaleString()}</span>{' '}
            feature{staged.features === 1 ? '' : 's'}
          </div>
          <div className="mt-1">
            <FieldChips fields={fields} />
          </div>
          {staged.warnings.length > 0 ? (
            <ul className="mt-2 space-y-0.5 text-[11px] text-warn">
              {staged.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
          <div className="mt-3 flex items-center gap-2">
            {saved ? (
              <span className="inline-flex items-center gap-1 text-xs text-success">
                <Check className="h-3.5 w-3.5" />
                Saved
              </span>
            ) : null}
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save replacement
            </button>
            <button
              type="button"
              onClick={onDiscard}
              disabled={saving}
              className="inline-flex h-8 items-center rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2"
            >
              Discard
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FileDropZone({
  busy,
  onFile,
}: {
  busy: boolean;
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
      className={`flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 text-center transition-colors ${
        over ? 'border-accent bg-accent/5' : 'border-border bg-surface-1'
      } ${busy ? 'pointer-events-none opacity-60' : ''}`}
    >
      {busy ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted" />
      ) : (
        <Upload className="h-5 w-5 text-muted" />
      )}
      <p className="text-sm text-ink-1">
        {busy ? 'Parsing file...' : 'Drop a file here'}
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
        accept=".kml,.kmz,.geojson,.json,.zip,.gdb,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/geo+json,application/json,application/zip"
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

function FieldChips({ fields }: { fields: FeatureField[] }) {
  if (fields.length === 0) {
    return <p className="mt-1 text-sm text-muted">No attributes detected.</p>;
  }
  return (
    <ul className="mt-2 flex flex-wrap gap-1">
      {fields.map((f) => (
        <li
          key={f.name}
          className="inline-flex items-baseline gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs"
        >
          <span className="font-medium">{f.name}</span>
          <span className="text-[10px] text-muted">{f.type}</span>
        </li>
      ))}
    </ul>
  );
}

function TabBtn({
  Icon,
  label,
  active,
  onClick,
}: {
  Icon: typeof Upload;
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

/**
 * Walk a feature sample and build the field list with guessed types.
 * Heuristic is intentionally simple: whichever non-null type appears
 * first on a property wins. A future version can look at every feature
 * and pick the best-fit type / nullability.
 */
function deriveFields(
  features: Array<{ properties?: Record<string, unknown> }>,
  cap: number,
): FeatureField[] {
  const fieldMap = new Map<string, FeatureField>();
  for (const f of features.slice(0, cap)) {
    for (const [k, v] of Object.entries(f.properties ?? {})) {
      if (fieldMap.has(k)) continue;
      const type: FeatureField['type'] =
        typeof v === 'number'
          ? 'number'
          : typeof v === 'boolean'
            ? 'boolean'
            : 'string';
      fieldMap.set(k, { name: k, type, label: k, nullable: true });
    }
  }
  return [...fieldMap.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function formatLabel(format: SpatialFormat): string {
  switch (format) {
    case 'geojson':
      return 'GeoJSON';
    case 'kml':
      return 'KML';
    case 'kmz':
      return 'KMZ';
    case 'shapefile-zip':
      return 'Shapefile';
    case 'fgdb':
      return 'File Geodatabase';
    default:
      return 'Unknown';
  }
}
