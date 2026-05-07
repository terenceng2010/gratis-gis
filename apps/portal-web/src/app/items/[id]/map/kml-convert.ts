// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Thin compatibility shim. Original parsing logic moved to
 * `src/lib/spatial-import.ts` so feature-service ingest and add-layer
 * dialog share one implementation; this file keeps the old
 * `fileToGeoJson` name working for any importer that hasn't migrated.
 */
import { importSpatialFile } from '@/lib/spatial-import';

export async function fileToGeoJson(
  file: File,
): Promise<GeoJSON.FeatureCollection> {
  const result = await importSpatialFile(file);
  return result.geojson;
}
