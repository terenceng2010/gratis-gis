// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Size + complexity guards for user-supplied GeoJSON.
 *
 * GratisGIS accepts user-supplied geometry in a handful of places:
 *   - the engine's `geoLimit` / `boundaryClip` filters
 *   - per-share `geoLimit` polygons loaded from `ItemShare`
 *   - the feature-write paths in features.service and engine.service
 *   - derived-layer recipe inputs
 *
 * Every one of those paths stringifies the GeoJSON and embeds it
 * into a `ST_GeomFromGeoJSON()` call inside an `ST_Intersects()` or
 * similar predicate.  PostGIS parses, materializes, and intersects
 * arbitrary input geometry, and a single 50 MB MultiPolygon is
 * enough to peg one Postgres worker for the lifetime of the query.
 *
 * Combined with no statement_timeout (now set elsewhere as a
 * defense-in-depth), a pathological geometry posted as a query
 * parameter is a trivial one-request DoS.
 *
 * This helper bounds:
 *   1. JSON-encoded payload size at 256 KiB.  A real-world
 *      county boundary polygon serialized as GeoJSON usually fits
 *      comfortably under 50 KB; 256 KiB is generous.
 *   2. Total vertex count at 50_000.  Vertex counts above this
 *      indicate either a pathological input or a polygon that the
 *      caller should pre-simplify.
 *
 * Returns nothing on success and throws on failure.  The error
 * message is safe to surface to the client because it never echoes
 * any of the input payload back.
 *
 * Throws `BadRequestException` so NestJS surfaces a 400 rather than
 * a 500 when a malicious or careless caller posts an oversized
 * geometry.
 */
import { BadRequestException } from '@nestjs/common';

export class GeometryTooLargeError extends BadRequestException {
  constructor(reason: string) {
    super(`Geometry rejected: ${reason}`);
    this.name = 'GeometryTooLargeError';
  }
}

const MAX_JSON_BYTES = 256 * 1024; // 256 KiB
const MAX_VERTEX_COUNT = 50_000;

/**
 * Count the total number of coordinate vertices in a GeoJSON value.
 * Recurses through Feature, FeatureCollection, GeometryCollection,
 * and the standard geometry types.  Coordinates are arrays of
 * numbers at the leaf; we count the leaf array as one vertex
 * regardless of dimensionality (2D vs 3D coordinates count the same).
 */
function countVertices(node: unknown, budget: number): number {
  if (node === null || node === undefined) return 0;
  if (Array.isArray(node)) {
    // Leaf coordinate: [lon, lat] or [lon, lat, alt]
    if (node.length > 0 && typeof node[0] === 'number') {
      return 1;
    }
    // Array of coordinates / array of arrays.  Sum recursively.
    let total = 0;
    for (const child of node) {
      total += countVertices(child, budget - total);
      if (total > budget) return total;
    }
    return total;
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    let total = 0;
    if (obj.coordinates !== undefined) {
      total += countVertices(obj.coordinates, budget);
    }
    if (Array.isArray(obj.geometries)) {
      for (const g of obj.geometries) {
        total += countVertices(g, budget - total);
        if (total > budget) return total;
      }
    }
    if (obj.geometry !== undefined) {
      total += countVertices(obj.geometry, budget - total);
    }
    if (Array.isArray(obj.features)) {
      for (const f of obj.features) {
        total += countVertices(f, budget - total);
        if (total > budget) return total;
      }
    }
    return total;
  }
  return 0;
}

/**
 * Validate a user-supplied GeoJSON value (geometry, Feature, or
 * FeatureCollection) for size + complexity.  Throws
 * `GeometryTooLargeError` if the input exceeds the configured limits.
 *
 * Pass the parsed JS object, not the serialized JSON string.
 *
 * Callers should typically call this at the top of any function
 * that receives a user-supplied geometry and is about to pass it
 * to PostGIS via `ST_GeomFromGeoJSON()`.
 */
export function validateGeoJson(value: unknown): void {
  if (value === null || value === undefined) return;
  const json = JSON.stringify(value);
  if (json.length > MAX_JSON_BYTES) {
    throw new GeometryTooLargeError(
      `payload exceeds ${MAX_JSON_BYTES} bytes (got ${json.length})`,
    );
  }
  const vertices = countVertices(value, MAX_VERTEX_COUNT + 1);
  if (vertices > MAX_VERTEX_COUNT) {
    throw new GeometryTooLargeError(
      `too many vertices (got ${vertices}, max ${MAX_VERTEX_COUNT})`,
    );
  }
}
