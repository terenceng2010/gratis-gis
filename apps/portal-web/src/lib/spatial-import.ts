// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Unified spatial-file importer. Takes any supported vector file and
 * returns a GeoJSON FeatureCollection, plus metadata the caller can
 * surface in its UI (detected format, feature count, warnings).
 *
 * Supported today (all parsed in-browser, no server round trip):
 *   - GeoJSON (.geojson, .json)
 *   - KML (.kml)
 *   - KMZ (.kmz)
 *   - Shapefile delivered as a .zip (.shp + sidecars)
 *
 * Known gaps (rejected with a clear message):
 *   - File Geodatabase (.gdb or .gdb.zip). Only robust parser is GDAL,
 *     which we haven't wired server-side yet. Users are pointed at
 *     ArcGIS Pro / QGIS to re-export.
 *   - GML, KML-in-network-link, GeoPackage, MBTiles: land later.
 *
 * Parsing libraries are dynamically imported so formats users never
 * touch don't bloat the default bundle.
 */

export type SpatialFormat =
  | 'geojson'
  | 'kml'
  | 'kmz'
  | 'shapefile-zip'
  | 'fgdb'
  | 'unknown';

export interface SpatialImportResult {
  geojson: GeoJSON.FeatureCollection;
  format: SpatialFormat;
  features: number;
  warnings: string[];
}

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB; keeps inline storage honest.

/** Inspect the filename to pick a parser. Content-sniffing happens inside each branch. */
export function detectFormat(filename: string): SpatialFormat {
  const n = filename.toLowerCase();
  // FGDB check first so `.gdb.zip` doesn't fall into the shapefile branch.
  if (n.endsWith('.gdb.zip') || n.endsWith('.gdb')) return 'fgdb';
  if (n.endsWith('.kmz')) return 'kmz';
  if (n.endsWith('.kml')) return 'kml';
  if (n.endsWith('.geojson')) return 'geojson';
  if (n.endsWith('.json')) return 'geojson';
  if (n.endsWith('.zip')) return 'shapefile-zip';
  return 'unknown';
}

export async function importSpatialFile(file: File): Promise<SpatialImportResult> {
  if (file.size > MAX_BYTES) {
    throw new Error(
      `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the current cap is ${
        MAX_BYTES / 1024 / 1024
      } MB. Use a smaller sample or wait for server-side ingest.`,
    );
  }

  const format = detectFormat(file.name);

  if (format === 'fgdb') {
    throw new Error(
      'File Geodatabase (.gdb) import needs server-side GDAL, which is not yet wired up. For now, open the .gdb in ArcGIS Pro or QGIS and export to Shapefile or GeoJSON, then upload that.',
    );
  }

  if (format === 'geojson') {
    const text = await file.text();
    return parseGeojson(text, 'geojson');
  }

  if (format === 'kml') {
    const text = await file.text();
    const fc = await parseKml(text);
    return {
      geojson: fc,
      format: 'kml',
      features: fc.features.length,
      warnings: [],
    };
  }

  if (format === 'kmz') {
    const fc = await parseKmz(file);
    return {
      geojson: fc,
      format: 'kmz',
      features: fc.features.length,
      warnings: [],
    };
  }

  if (format === 'shapefile-zip') {
    const fc = await parseShapefileZip(file);
    return {
      geojson: fc,
      format: 'shapefile-zip',
      features: fc.features.length,
      warnings: [],
    };
  }

  throw new Error(
    'Unrecognized file type. Supported formats: GeoJSON, KML, KMZ, zipped Shapefile.',
  );
}

function parseGeojson(text: string, format: SpatialFormat): SpatialImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Top-level value must be a GeoJSON FeatureCollection.');
  }
  const obj = parsed as { type?: string; features?: unknown };
  if (obj.type !== 'FeatureCollection' || !Array.isArray(obj.features)) {
    throw new Error(
      'Top-level object must be `type: "FeatureCollection"` with a features array. Raw features or geometries aren\'t supported.',
    );
  }
  const fc = parsed as GeoJSON.FeatureCollection;
  return {
    geojson: fc,
    format,
    features: fc.features.length,
    warnings: [],
  };
}

async function parseKml(xml: string): Promise<GeoJSON.FeatureCollection> {
  const { kml } = await import('@tmcw/togeojson');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror')[0]) {
    throw new Error('That file is not valid KML XML.');
  }
  const fc = kml(doc);
  if (!fc || fc.type !== 'FeatureCollection') {
    throw new Error('KML converted to an unexpected shape; nothing to render.');
  }
  return {
    type: 'FeatureCollection',
    features: fc.features
      .filter((f): f is GeoJSON.Feature & { geometry: GeoJSON.Geometry } =>
        Boolean(f && f.geometry),
      )
      .map((f) => ({
        type: 'Feature' as const,
        geometry: f.geometry,
        properties: f.properties ?? {},
      })),
  };
}

async function parseKmz(file: File): Promise<GeoJSON.FeatureCollection> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  let entry = zip.file('doc.kml');
  if (!entry) {
    const kmls = Object.values(zip.files).filter(
      (f) => !f.dir && f.name.toLowerCase().endsWith('.kml'),
    );
    entry = kmls[0] ?? null;
  }
  if (!entry) throw new Error('KMZ archive has no .kml entry inside.');
  return parseKml(await entry.async('string'));
}

async function parseShapefileZip(file: File): Promise<GeoJSON.FeatureCollection> {
  // Sniff the zip to distinguish "this is a shapefile zip" from "this
  // is a zipped GDB that ended in .zip without .gdb". That lets us
  // give the latter its own helpful message.
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entries = Object.values(zip.files);
  if (entries.some((e) => /\.gdb\//i.test(e.name))) {
    throw new Error(
      'This zip looks like a File Geodatabase (.gdb). FGDB import needs server-side GDAL, which is not yet wired up. Export to Shapefile or GeoJSON from ArcGIS Pro / QGIS for now.',
    );
  }
  if (!entries.some((e) => /\.shp$/i.test(e.name))) {
    throw new Error(
      'No .shp file inside that zip. A shapefile zip needs at least the .shp, .dbf, and .prj components together.',
    );
  }

  const { default: shp } = await import('shpjs');
  const result = await shp(await file.arrayBuffer());
  // shpjs returns either a single FeatureCollection (one .shp in the
  // zip) or an array (multiple .shp layers). Flatten to one collection;
  // a future v2.5 feature could let the user keep them separate.
  if (Array.isArray(result)) {
    return {
      type: 'FeatureCollection',
      features: result.flatMap((fc) => fc.features ?? []),
    };
  }
  return result as GeoJSON.FeatureCollection;
}
