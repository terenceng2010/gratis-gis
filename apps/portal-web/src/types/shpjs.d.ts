// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Hand-written type stub for shpjs. The library ships no .d.ts; what
 * we actually use is one default-exported async function that takes a
 * URL or ArrayBuffer of a zipped shapefile (or a single `{ shp, dbf,
 * prj }` object) and resolves to either a GeoJSON FeatureCollection
 * (single shapefile) or an array of them (multi-layer zip).
 */
declare module 'shpjs' {
  const shp: (
    input: ArrayBuffer | string | Record<string, ArrayBuffer | string>,
  ) => Promise<GeoJSON.FeatureCollection | GeoJSON.FeatureCollection[]>;
  export default shp;
}
