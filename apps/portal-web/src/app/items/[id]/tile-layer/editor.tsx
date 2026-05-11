// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { PMTiles, Protocol } from 'pmtiles';
import {
  Check,
  Copy,
  Loader2,
  RefreshCw,
  Upload as UploadIcon,
} from 'lucide-react';
import type { TileLayerData } from '@gratis-gis/shared-types';
import { isTileLayerData } from '@gratis-gis/shared-types';

/**
 * Detail-page editor for tile_layer items (#179). Three states:
 *
 *   1. No file uploaded yet: shows an upload affordance + the
 *      list of supported formats (PMTiles in v1).
 *   2. Upload in progress: shows the file name + a progress bar.
 *   3. File uploaded and metadata extracted: shows the metadata
 *      (file size, zoom range, bbox, tile type, attribution) +
 *      a map preview rendered through the pmtiles protocol +
 *      a copyable tile URL for use in basemaps.
 *
 * Replace-file: the existing item can have its bytes swapped by
 * uploading a new file. The old MinIO object is left in place;
 * we'd want a cleanup pass eventually but for v1 the orphan
 * accounting on the storage card surfaces it.
 *
 * Map preview uses MapLibre GL's pmtiles protocol plugin
 * (registered once per page load). For raster tile types we add a
 * raster source + layer; for vector (mvt) we add a vector source
 * and a thin debug fill layer so the user at least sees that
 * tiles are being served, even if they haven't authored a style
 * yet. A future iteration could probe the vector layers and
 * render a meaningful default style.
 */
interface Props {
  itemId: string;
  initial: TileLayerData;
  canEdit: boolean;
}

export function TileLayerEditor({ itemId, initial, canEdit }: Props) {
  const [data, setData] = useState<TileLayerData>(initial);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [copied, setCopied] = useState(false);

  // Register the pmtiles protocol with MapLibre once per page
  // load. The Protocol class intercepts pmtiles:// URLs and
  // serves tile bytes via range requests against the underlying
  // HTTP URL. Idempotent registration so HMR re-renders don't
  // double-register.
  useEffect(() => {
    const proto = new Protocol();
    maplibregl.addProtocol('pmtiles', proto.tile);
    return () => {
      maplibregl.removeProtocol('pmtiles');
    };
  }, []);

  async function pickFile() {
    fileInputRef.current?.click();
  }

  async function onFileChange(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file) return;
    // Reset the input so the same file can be selected twice (a
    // re-upload of the same name shouldn't be silently ignored).
    ev.target.value = '';
    if (!file.name.toLowerCase().endsWith('.pmtiles')) {
      setUploadError(
        'Only .pmtiles files are supported in v1. MBTiles + TPK ingestion is tracked as a follow-up.',
      );
      return;
    }
    await runUpload(file);
  }

  async function runUpload(file: File) {
    setUploadError(null);
    setUploadProgress(0);
    setUploading(true);
    try {
      // 1) Ask the api for a presigned PUT.
      const presignRes = await fetch('/api/portal/storage/presign-upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'item-tile-layer',
          contentType: 'application/octet-stream',
        }),
      });
      if (!presignRes.ok) {
        let msg = `Presign failed (HTTP ${presignRes.status}).`;
        try {
          const body = (await presignRes.json()) as { message?: unknown };
          if (typeof body.message === 'string') msg = body.message;
        } catch {
          /* keep fallback */
        }
        setUploadError(msg);
        return;
      }
      const presign = (await presignRes.json()) as {
        uploadUrl: string;
        publicUrl: string;
        key: string;
        maxBytes: number;
      };
      if (file.size > presign.maxBytes) {
        setUploadError(
          `File is ${(file.size / 1024 / 1024).toFixed(1)} MB but the per-file limit is ${(presign.maxBytes / 1024 / 1024 / 1024).toFixed(1)} GB.`,
        );
        return;
      }

      // 2) PUT the bytes to MinIO, tracking progress through an
      // XHR (fetch doesn't expose upload progress). XHR is the
      // baseline; we'd switch to fetch+stream if the browser
      // matrix ever drops XHR.
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setUploadProgress(Math.round((e.loaded / e.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed (HTTP ${xhr.status})`));
          }
        };
        xhr.onerror = () => reject(new Error('Upload network error'));
        xhr.open('PUT', presign.uploadUrl);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.send(file);
      });

      // 3) Tell the api to finalize: read the PMTiles header
      // from the uploaded file, extract metadata, persist on the
      // item. This is where the slow header-parse happens; we
      // already showed 100% so the user sees that the bytes are
      // done and we're just reading the header.
      setUploadProgress(100);
      const finalizeRes = await fetch(
        `/api/portal/items/${itemId}/tile-layer/finalize`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            storageKey: presign.key,
            storageUrl: presign.publicUrl,
            fileName: file.name,
            sizeBytes: file.size,
          }),
        },
      );
      if (!finalizeRes.ok) {
        let msg = `Finalize failed (HTTP ${finalizeRes.status}).`;
        try {
          const body = (await finalizeRes.json()) as { message?: unknown };
          if (typeof body.message === 'string') msg = body.message;
        } catch {
          /* keep fallback */
        }
        setUploadError(msg);
        return;
      }
      const body = (await finalizeRes.json()) as { data: TileLayerData };
      setData(body.data);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }

  async function copyTileUrl() {
    if (!data.tileUrl) return;
    try {
      await navigator.clipboard.writeText(data.tileUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard not allowed; the input field is still selectable */
    }
  }

  const ready = isTileLayerData(data) && data.storageUrl.length > 0;

  return (
    <div className="space-y-4">
      {/* File / upload card */}
      <section className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
        <div className="border-b border-border bg-surface-2 px-4 py-3">
          <h3 className="text-sm font-medium text-ink-0">Tile cache file</h3>
          <p className="mt-0.5 text-xs text-muted">
            Upload a PMTiles file. Range-served straight from object
            storage; no per-tile compute on the API. MBTiles and TPK
            ingestion are tracked as follow-ups -- convert your file
            to PMTiles for now (the open-source <code>pmtiles</code>{' '}
            CLI does this in one command).
          </p>
        </div>
        <div className="space-y-3 p-4 text-sm">
          {ready ? (
            <div className="space-y-1.5">
              <div className="flex items-baseline gap-2 text-ink-0">
                <span className="font-medium">{data.fileName}</span>
                <span className="text-xs text-muted">
                  {humanSize(data.sizeBytes)}
                </span>
              </div>
              {data.name || data.description ? (
                <p className="text-xs text-muted">
                  {data.name ? <strong>{data.name}</strong> : null}
                  {data.name && data.description ? ' — ' : ''}
                  {data.description ?? null}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted">
              No tile file uploaded yet.
            </p>
          )}
          {canEdit ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void pickFile()}
                disabled={uploading}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
              >
                {uploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : ready ? (
                  <RefreshCw className="h-4 w-4" />
                ) : (
                  <UploadIcon className="h-4 w-4" />
                )}
                {uploading
                  ? `Uploading ${uploadProgress}%...`
                  : ready
                    ? 'Replace file'
                    : 'Upload .pmtiles'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pmtiles"
                onChange={(e) => void onFileChange(e)}
                className="hidden"
              />
            </div>
          ) : null}
          {uploadError ? (
            <p className="text-xs text-danger" role="alert">
              {uploadError}
            </p>
          ) : null}
        </div>
      </section>

      {/* Metadata card */}
      {ready ? (
        <section className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
          <div className="border-b border-border bg-surface-2 px-4 py-3">
            <h3 className="text-sm font-medium text-ink-0">Cache details</h3>
            <p className="mt-0.5 text-xs text-muted">
              Lifted from the PMTiles header at upload time. Re-upload
              to refresh after rebuilding the cache.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 p-4 text-xs sm:grid-cols-2">
            <Metric
              label="Format"
              value={`${data.format.toUpperCase()} (${data.kind})`}
            />
            <Metric
              label="Tile type"
              value={data.tileType ? data.tileType.toUpperCase() : 'unknown'}
            />
            <Metric
              label="Zoom range"
              value={
                data.minZoom !== undefined && data.maxZoom !== undefined
                  ? `${data.minZoom} – ${data.maxZoom}`
                  : '(not advertised)'
              }
            />
            <Metric label="Size on disk" value={humanSize(data.sizeBytes)} />
            <Metric
              label="Bbox"
              value={
                data.bbox
                  ? `${data.bbox[0].toFixed(3)}, ${data.bbox[1].toFixed(3)}, ${data.bbox[2].toFixed(3)}, ${data.bbox[3].toFixed(3)}`
                  : '(not advertised)'
              }
            />
            <Metric
              label="Center"
              value={
                data.centerLng !== undefined && data.centerLat !== undefined
                  ? `${data.centerLng.toFixed(3)}, ${data.centerLat.toFixed(3)}${data.centerZoom !== undefined ? ` (z${data.centerZoom})` : ''}`
                  : '(not advertised)'
              }
            />
            {data.attribution ? (
              <div className="sm:col-span-2">
                <Metric label="Attribution" value={data.attribution} />
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Tile URL + use-as-basemap card */}
      {ready && data.tileUrl ? (
        <section className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
          <div className="border-b border-border bg-surface-2 px-4 py-3">
            <h3 className="text-sm font-medium text-ink-0">
              Use as basemap
            </h3>
            <p className="mt-0.5 text-xs text-muted">
              Copy this URL and paste it into a Basemap item&rsquo;s
              source field (the Basemap editor recognizes{' '}
              <code>pmtiles://</code> URLs and serves them through
              the API&rsquo;s range-request proxy).
            </p>
          </div>
          <div className="flex gap-2 p-4">
            <input
              type="text"
              value={data.tileUrl}
              readOnly
              onFocus={(e) => e.target.select()}
              className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => void copyTileUrl()}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 hover:bg-surface-2"
            >
              {copied ? (
                <Check className="h-4 w-4 text-accent" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </section>
      ) : null}

      {/* Preview map */}
      {ready ? <TilePreview data={data} /> : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-2 p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 font-mono text-ink-0">{value}</p>
    </div>
  );
}

/**
 * Small MapLibre preview rendering the tile layer via the
 * pmtiles:// protocol. For raster caches it adds a raster source
 * + layer; for vector caches it adds a vector source + a
 * placeholder fill layer (vector content needs a real style to
 * render meaningfully; this surfaces "tiles are served" without
 * pretending to know the source-layer schema).
 */
function TilePreview({ data }: { data: TileLayerData }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const center: [number, number] =
      data.centerLng !== undefined && data.centerLat !== undefined
        ? [data.centerLng, data.centerLat]
        : data.bbox
          ? [
              (data.bbox[0] + data.bbox[2]) / 2,
              (data.bbox[1] + data.bbox[3]) / 2,
            ]
          : [0, 0];
    const initialZoom =
      data.centerZoom ??
      (data.minZoom !== undefined ? data.minZoom : 1);

    // Build a minimal style that includes a neutral backdrop +
    // the pmtiles layer. The backdrop is OSM raster so the user
    // can see geography even when the cache covers a small region
    // (a county-level cache against a black background reads as
    // "nothing here"; the OSM context fixes that).
    const isRaster = data.kind === 'raster';
    const style: maplibregl.StyleSpecification = {
      version: 8,
      sources: {
        backdrop: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '(c) OpenStreetMap contributors',
        },
        ...(isRaster
          ? ({
              tilecache: {
                type: 'raster',
                url: data.tileUrl ?? '',
                tileSize: 256,
                ...(data.minZoom !== undefined
                  ? { minzoom: data.minZoom }
                  : {}),
                ...(data.maxZoom !== undefined
                  ? { maxzoom: data.maxZoom }
                  : {}),
                ...(data.attribution
                  ? { attribution: data.attribution }
                  : {}),
              },
            } as maplibregl.StyleSpecification['sources'])
          : ({
              tilecache: {
                type: 'vector',
                url: data.tileUrl ?? '',
                ...(data.minZoom !== undefined
                  ? { minzoom: data.minZoom }
                  : {}),
                ...(data.maxZoom !== undefined
                  ? { maxzoom: data.maxZoom }
                  : {}),
                ...(data.attribution
                  ? { attribution: data.attribution }
                  : {}),
              },
            } as maplibregl.StyleSpecification['sources'])),
      },
      layers: [
        { id: 'backdrop', type: 'raster', source: 'backdrop' },
        isRaster
          ? {
              id: 'tilecache-raster',
              type: 'raster',
              source: 'tilecache',
              paint: { 'raster-opacity': 0.9 },
            }
          : {
              id: 'tilecache-vector-debug',
              type: 'line',
              source: 'tilecache',
              // No source-layer specified, MapLibre renders all
              // layers in the tile. Acceptable for a preview;
              // production consumers configure source-layer +
              // style per layer.
              'source-layer': '',
              paint: { 'line-color': '#7c3aed', 'line-width': 1 },
            },
      ],
    };

    const map = new maplibregl.Map({
      container: containerRef.current,
      style,
      center,
      zoom: initialZoom,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }));
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [data]);

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
      <div className="border-b border-border bg-surface-2 px-4 py-3">
        <h3 className="text-sm font-medium text-ink-0">Preview</h3>
        <p className="mt-0.5 text-xs text-muted">
          Rendered through the API&rsquo;s pmtiles proxy. Pan and zoom
          to verify the cache covers what you expect.
        </p>
      </div>
      <div ref={containerRef} className="h-[420px] w-full bg-surface-0" />
    </section>
  );
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
