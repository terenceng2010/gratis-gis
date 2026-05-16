// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bundle export (#109): pack a v3 data_layer's features + related
 * tables + feature attachments into a single ZIP archive the user
 * can hand to a client or open in Excel.
 *
 * Why client-side: the alternative was a server-side ZIP-streaming
 * endpoint + async job queue (the design tracked in
 * docs/handoff/reference/bundle-export-notes.md).  For a typical
 * municipal-scale data_layer (a few thousand parcels + attachments)
 * the in-browser path fits comfortably in memory, reuses the
 * existing layer-export writer + JSZip dep, and avoids a new server
 * surface entirely.  When users start hitting the 50k-feature /
 * 10GB-of-photos case we'll lift this server-side; until then,
 * client-side is the right call.
 *
 * ZIP layout (matches Matt's existing Pro/VertiGIS convention so
 * downstream scripts pattern-match without retraining):
 *
 *   <layer name>/
 *     data.xlsx                 (one sheet per layer, parent first,
 *                                related tables after; FK columns
 *                                preserved verbatim so the user can
 *                                re-join in Excel)
 *     attachments/
 *       <prefix>_ATT<id>_<original>.jpg
 *       ...
 *
 * `<prefix>` is the value of a configurable layer field when the
 * caller sets `attachmentPrefixField`; otherwise it's the feature's
 * global id (truncated to a sensible length).
 *
 * Progress is reported through an optional onProgress callback so
 * the UI can render "Building data.xlsx", "Fetching attachments
 * 23 / 412", etc.  Cancellation is a TODO -- a long export today
 * runs to completion or the user closes the tab.
 */

import JSZip from 'jszip';
import * as XLSX from 'xlsx';

export interface BundleExportOptions {
  /** Root data_layer item id. */
  itemId: string;
  /** Top-level sublayer to export.  Related tables are discovered
   *  by walking childLayerIds on this layer's schema. */
  layerKey: string;
  /** Optional layer schema (pulled from the item's data blob) so
   *  related tables can be enumerated without an extra round-trip.
   *  When omitted the bundle exports just the parent layer. */
  layers?: BundleSublayer[];
  /** Filename root for the downloaded ZIP.  Sanitized before use. */
  filename: string;
  /** When true, include related-table sheets in the workbook
   *  (recursively if a child has its own children). */
  includeRelatedTables: boolean;
  /** When true, fetch + bundle every attachment for every feature
   *  on every included layer.  Massively increases bundle size for
   *  layers with photos; off by default for that reason. */
  includeAttachments: boolean;
  /**
   * Optional attribute name whose value will prefix attachment
   * filenames.  When omitted, the global id is used.  Matches the
   * naming convention Matt's Pro tool uses so emails to clients
   * read the same as before.
   */
  attachmentPrefixField?: string;
  /**
   * Optional second field name; when set, attachments split into
   * subfolders by that field's value.  Falls back to a flat
   * attachments/ folder when unset.  Mirrors the Pro tool's
   * "Organize by attribute" option.
   */
  attachmentSplitField?: string;
  /** Progress callback for the UI. */
  onProgress?: (msg: string) => void;
}

export interface BundleSublayer {
  /** Sublayer id (matches the layer's `id` in v3 data_layer data). */
  id: string;
  /** Author-facing label, used as the sheet name + folder names. */
  label: string;
  /** PostGIS-style stable name (used in filenames where label has
   *  spaces). */
  name: string;
  /** Field list for column ordering. */
  fields?: Array<{ name: string; label?: string }>;
  /** When set, this is a related table whose rows reference the
   *  parent by `id`. */
  parentLayerId?: string;
}

interface BundleFeature {
  id?: string;
  geometry?: unknown;
  properties?: Record<string, unknown> | null;
}

interface AttachmentRow {
  id: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  storageUrl: string;
}

/**
 * Pull features for one layer via the existing API.  Accepts both
 * shapes the endpoint returns: a bare array and a `{ features }`
 * envelope.
 */
async function fetchLayerFeatures(
  itemId: string,
  layerKey: string,
): Promise<BundleFeature[]> {
  const res = await fetch(
    `/api/portal/items/${encodeURIComponent(itemId)}/layers/${encodeURIComponent(layerKey)}/features`,
    { cache: 'no-store' },
  );
  if (!res.ok) {
    throw new Error(
      `Layer features fetch failed: ${res.status} ${await res.text()}`,
    );
  }
  const body = (await res.json()) as
    | BundleFeature[]
    | { features?: BundleFeature[] };
  return Array.isArray(body) ? body : body.features ?? [];
}

/** Pull the attachment rows for one feature. */
async function fetchAttachmentList(
  itemId: string,
  layerKey: string,
  featureId: string,
): Promise<AttachmentRow[]> {
  const res = await fetch(
    `/api/portal/items/${encodeURIComponent(itemId)}/layers/${encodeURIComponent(layerKey)}/features/${encodeURIComponent(featureId)}/attachments`,
    { cache: 'no-store' },
  );
  if (!res.ok) return [];
  return (await res.json()) as AttachmentRow[];
}

/** Sanitize a string into a safe ZIP entry path segment. */
function sanitizeSegment(raw: string): string {
  return raw
    .trim()
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'item';
}

/**
 * Coerce a property value into a primitive an XLSX cell can hold.
 * Mirrors layer-export.ts's coerceCell.  Kept private here so a
 * future shared helper module can absorb both without churn.
 */
function coerceCell(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return '';
  if (
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  ) {
    return v;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Build a 2D row array from features + field schema. */
function buildSheetRows(
  features: BundleFeature[],
  fields: Array<{ name: string; label?: string }>,
): (string | number | boolean | null)[][] {
  const headers: string[] = [];
  const keys: string[] = [];
  const seen = new Set<string>();
  if (fields.length > 0) {
    for (const f of fields) {
      if (seen.has(f.name)) continue;
      headers.push(f.label?.trim() || f.name);
      keys.push(f.name);
      seen.add(f.name);
    }
  } else {
    for (const f of features) {
      const props = f.properties ?? {};
      for (const k of Object.keys(props)) {
        if (seen.has(k)) continue;
        headers.push(k);
        keys.push(k);
        seen.add(k);
      }
    }
  }
  const out: (string | number | boolean | null)[][] = [headers];
  for (const f of features) {
    const row: (string | number | boolean | null)[] = [];
    const props = f.properties ?? {};
    for (const k of keys) row.push(coerceCell(props[k]));
    out.push(row);
  }
  return out;
}

/**
 * Compute the export plan: which sublayers to include + their
 * order.  Parent first, then immediate children (recursively).
 */
function planLayers(
  rootKey: string,
  all: BundleSublayer[],
  includeRelated: boolean,
): BundleSublayer[] {
  const byId = new Map(all.map((l) => [l.id, l]));
  const root = byId.get(rootKey);
  if (!root) return [];
  if (!includeRelated) return [root];
  const out: BundleSublayer[] = [root];
  const stack: string[] = [root.id];
  const visited = new Set<string>([root.id]);
  while (stack.length > 0) {
    const parentId = stack.pop()!;
    for (const candidate of all) {
      if (candidate.parentLayerId === parentId && !visited.has(candidate.id)) {
        visited.add(candidate.id);
        out.push(candidate);
        stack.push(candidate.id);
      }
    }
  }
  return out;
}

/** Truncate + sanitize sheet names to the XLSX 31-char limit. */
function sheetName(layer: BundleSublayer): string {
  const raw = (layer.label || layer.name || 'sheet').replace(/[/\\?*[\]:]/g, '');
  return raw.slice(0, 31) || 'sheet';
}

/** Trigger a browser download of a Blob. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60);
}

/**
 * Build and download a bundle ZIP for the given layer + options.
 *
 * Returns a summary of what was packed so the caller can render a
 * "Done -- N features + M attachments" confirmation.
 */
export async function exportBundle(opts: BundleExportOptions): Promise<{
  layerCount: number;
  featureCount: number;
  attachmentCount: number;
  bytes: number;
}> {
  const progress = opts.onProgress ?? (() => undefined);
  const allLayers = opts.layers ?? [];
  const plan = planLayers(
    opts.layerKey,
    allLayers.length > 0
      ? allLayers
      : [{ id: opts.layerKey, label: 'Layer', name: 'layer' }],
    opts.includeRelatedTables,
  );

  // Map of layerKey -> features, populated as we walk.  We hold all
  // features in memory while building the workbook because XLSX's
  // aoa_to_sheet wants the full 2D array up front.  For very large
  // exports this is the memory bottleneck; the v2 server-side path
  // streams sheet-at-a-time instead.
  const featuresByLayer = new Map<string, BundleFeature[]>();
  let totalFeatures = 0;
  for (const layer of plan) {
    progress(`Fetching ${layer.label || layer.id}…`);
    const features = await fetchLayerFeatures(opts.itemId, layer.id);
    featuresByLayer.set(layer.id, features);
    totalFeatures += features.length;
  }

  // Build the workbook: one sheet per layer.
  progress('Building data.xlsx…');
  const wb = XLSX.utils.book_new();
  for (const layer of plan) {
    const features = featuresByLayer.get(layer.id) ?? [];
    const rows = buildSheetRows(features, layer.fields ?? []);
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, sheet, sheetName(layer));
  }
  const xlsxBytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

  // Build the ZIP.  Layout: <rootName>/data.xlsx + optional
  // attachments folder per layer.
  const zip = new JSZip();
  const rootName = sanitizeSegment(opts.filename);
  const rootFolder = zip.folder(rootName);
  if (!rootFolder) {
    throw new Error('ZIP root folder creation failed');
  }
  rootFolder.file('data.xlsx', xlsxBytes);

  let attachmentCount = 0;
  if (opts.includeAttachments) {
    const attachmentsFolder = rootFolder.folder('attachments');
    if (!attachmentsFolder) {
      throw new Error('attachments folder creation failed');
    }
    // For each layer, for each feature, fetch attachments + bundle.
    // Errors fetching one attachment don't fail the whole bundle:
    // they're logged + counted as a soft warning so a single
    // permission error doesn't kill an otherwise-good export.
    let processed = 0;
    for (const layer of plan) {
      const features = featuresByLayer.get(layer.id) ?? [];
      for (const f of features) {
        processed += 1;
        if (processed % 25 === 0) {
          progress(`Fetching attachments ${processed} / ${totalFeatures}…`);
        }
        if (!f.id) continue;
        const list = await fetchAttachmentList(opts.itemId, layer.id, f.id);
        if (list.length === 0) continue;

        // Resolve the per-feature filename prefix.  Prefer the
        // configured field's value (matches Pro tool convention),
        // fall back to a truncated global id.
        let prefix = '';
        if (
          opts.attachmentPrefixField &&
          f.properties &&
          typeof f.properties === 'object'
        ) {
          const raw = (f.properties as Record<string, unknown>)[
            opts.attachmentPrefixField
          ];
          if (typeof raw === 'string' || typeof raw === 'number') {
            prefix = sanitizeSegment(String(raw));
          }
        }
        if (!prefix) prefix = f.id.slice(0, 8);

        // Optional split-by-field: drop attachments under a subfolder
        // named for the field's value.  Files for that feature land
        // at <splitValue>/<prefix>_ATT<id>_<original>.
        let folder = attachmentsFolder;
        if (
          opts.attachmentSplitField &&
          f.properties &&
          typeof f.properties === 'object'
        ) {
          const raw = (f.properties as Record<string, unknown>)[
            opts.attachmentSplitField
          ];
          if (typeof raw === 'string' || typeof raw === 'number') {
            const sub = sanitizeSegment(String(raw));
            if (sub) {
              const subFolder = attachmentsFolder.folder(sub);
              if (subFolder) folder = subFolder;
            }
          }
        }

        for (const att of list) {
          try {
            const r = await fetch(att.storageUrl, { cache: 'no-store' });
            if (!r.ok) {
              console.warn('[bundle] attachment fetch failed', att.id, r.status);
              continue;
            }
            const blob = await r.blob();
            const safeName = sanitizeSegment(
              att.fileName.replace(/\s+/g, ''),
            );
            const finalName = `${prefix}_ATT${att.id.slice(0, 8)}_${safeName}`;
            folder.file(finalName, blob);
            attachmentCount += 1;
          } catch (err) {
            console.warn('[bundle] attachment error', att.id, err);
          }
        }
      }
    }
  }

  progress('Compressing…');
  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  downloadBlob(zipBlob, `${rootName}.zip`);

  return {
    layerCount: plan.length,
    featureCount: totalFeatures,
    attachmentCount,
    bytes: zipBlob.size,
  };
}
