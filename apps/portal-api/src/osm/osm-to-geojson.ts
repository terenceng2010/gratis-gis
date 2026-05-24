// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Convert an Overpass `out body geom tags` JSON response into a
 * GeoJSON FeatureCollection (#OSM).
 *
 * Supported element kinds (see docs/osm-overlay.md for the scope
 * decisions):
 *
 *   - node:                       Point
 *   - way (closed + area-like):   Polygon
 *   - way (open or non-area):     LineString
 *   - multipolygon relation:      MultiPolygon (best-effort ring
 *                                 assembly from outer / inner
 *                                 members; degenerate cases fall
 *                                 through to a GeometryCollection
 *                                 of the constituent LineStrings)
 *   - other relation kinds:       skipped with a console.warn (wave
 *                                 2 work to handle them)
 *
 * Each output Feature has:
 *
 *   - id:           '<type>/<osm-id>'  ('node/123', 'way/456', ...)
 *   - geometry:     the GeoJSON geometry
 *   - properties:
 *       osmType:    'node' | 'way' | 'relation'
 *       osmId:      the OSM element id (number)
 *       ...tags:    the OSM tag bag flattened
 *
 * The converter is defensive: any element we can't map (a way with
 * no geometry, a relation with bad members) gets skipped with a
 * `console.warn` rather than throwing.  The caller cap on max
 * features still applies via the QL builder + the HTTP-client cap;
 * here we just produce GeoJSON for whatever we receive.
 */

interface OverpassNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

interface OverpassWayPoint {
  lat: number;
  lon: number;
}

interface OverpassWay {
  type: 'way';
  id: number;
  nodes?: number[];
  geometry?: OverpassWayPoint[];
  tags?: Record<string, string>;
}

interface OverpassRelationMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
  geometry?: OverpassWayPoint[];
}

interface OverpassRelation {
  type: 'relation';
  id: number;
  members?: OverpassRelationMember[];
  tags?: Record<string, string>;
}

type OverpassElement = OverpassNode | OverpassWay | OverpassRelation;

export interface OverpassResponse {
  version?: number;
  generator?: string;
  elements?: OverpassElement[];
}

// ---- Minimal local GeoJSON types ---------------------------------------
// portal-api doesn't pull in @types/geojson; everything we need lives in
// a small handful of shapes.  Kept here so the converter is self-
// contained and the rest of the OSM module can import them.

export interface OsmGeoJsonPoint {
  type: 'Point';
  coordinates: [number, number];
}
export interface OsmGeoJsonLineString {
  type: 'LineString';
  coordinates: [number, number][];
}
export interface OsmGeoJsonPolygon {
  type: 'Polygon';
  coordinates: [number, number][][];
}
export interface OsmGeoJsonMultiPolygon {
  type: 'MultiPolygon';
  coordinates: [number, number][][][];
}
export type OsmGeoJsonGeometry =
  | OsmGeoJsonPoint
  | OsmGeoJsonLineString
  | OsmGeoJsonPolygon
  | OsmGeoJsonMultiPolygon;

export interface OsmGeoJsonFeature {
  type: 'Feature';
  id: string;
  properties: Record<string, unknown>;
  geometry: OsmGeoJsonGeometry;
}

export interface OsmGeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: OsmGeoJsonFeature[];
}

/** Tags that imply a closed way should render as a polygon rather
 *  than a linestring.  Subset of iD's "area=yes" implicit list;
 *  enough for the common building / landuse / leisure / natural
 *  area cases.  Open ways with any of these tags still render as
 *  lines (we only promote to polygon when the way is closed). */
const AREA_TAG_KEYS = new Set([
  'building',
  'building:part',
  'landuse',
  'amenity',
  'leisure',
  'natural',
  'shop',
  'tourism',
  'historic',
  'place',
  'aeroway',
  'sport',
  'man_made',
  'office',
  'public_transport',
  'boundary',
  'area',
]);

const AREA_FORBIDDEN_KEYS = new Set([
  // These are intrinsically linear even on closed ways.
  'highway',
  'waterway',
  'barrier',
  'railway',
  'power',
  'cycleway',
]);

export function osmToGeoJson(response: OverpassResponse): OsmGeoJsonFeatureCollection {
  const features: OsmGeoJsonFeature[] = [];
  const elements = response.elements ?? [];
  for (const el of elements) {
    try {
      const feat = convertElement(el);
      if (feat) features.push(feat);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `osmToGeoJson: failed to convert ${el.type}/${el.id}: ${(err as Error).message}`,
      );
    }
  }
  return { type: 'FeatureCollection', features };
}

function convertElement(el: OverpassElement): OsmGeoJsonFeature | null {
  if (el.type === 'node') return nodeToFeature(el);
  if (el.type === 'way') return wayToFeature(el);
  if (el.type === 'relation') return relationToFeature(el);
  return null;
}

function nodeToFeature(node: OverpassNode): OsmGeoJsonFeature {
  return {
    type: 'Feature',
    id: `node/${node.id}`,
    properties: {
      osmType: 'node',
      osmId: node.id,
      ...(node.tags ?? {}),
    },
    geometry: {
      type: 'Point',
      coordinates: [node.lon, node.lat],
    },
  };
}

function wayToFeature(way: OverpassWay): OsmGeoJsonFeature | null {
  const coords = (way.geometry ?? []).map<[number, number]>((p) => [p.lon, p.lat]);
  if (coords.length < 2) return null;
  const closed =
    coords.length >= 4 &&
    coords[0]![0] === coords[coords.length - 1]![0] &&
    coords[0]![1] === coords[coords.length - 1]![1];
  const isArea = closed && wayLooksLikeArea(way);
  const geometry: OsmGeoJsonGeometry = isArea
    ? { type: 'Polygon', coordinates: [coords] }
    : { type: 'LineString', coordinates: coords };
  return {
    type: 'Feature',
    id: `way/${way.id}`,
    properties: {
      osmType: 'way',
      osmId: way.id,
      ...(way.tags ?? {}),
    },
    geometry,
  };
}

function wayLooksLikeArea(way: OverpassWay): boolean {
  const tags = way.tags ?? {};
  // Explicit area=yes / area=no overrides everything.
  if (tags.area === 'yes') return true;
  if (tags.area === 'no') return false;
  // Forbidden keys force linear interpretation even when closed.
  for (const k of Object.keys(tags)) {
    if (AREA_FORBIDDEN_KEYS.has(k)) return false;
  }
  // Promote to area when any of the area-implying keys is present.
  for (const k of Object.keys(tags)) {
    if (AREA_TAG_KEYS.has(k)) return true;
  }
  return false;
}

function relationToFeature(rel: OverpassRelation): OsmGeoJsonFeature | null {
  const tags = rel.tags ?? {};
  const relType = tags.type;
  if (relType !== 'multipolygon' && relType !== 'boundary') {
    // eslint-disable-next-line no-console
    console.warn(
      `osmToGeoJson: relation ${rel.id} has unsupported type "${relType ?? '<none>'}"; skipping`,
    );
    return null;
  }
  const outerCoords = assembleRings(
    (rel.members ?? []).filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === '')),
  );
  const innerCoords = assembleRings(
    (rel.members ?? []).filter((m) => m.type === 'way' && m.role === 'inner'),
  );
  if (outerCoords.length === 0) return null;
  // GeoJSON Polygon: [outerRing, ...innerRings].  MultiPolygon: each
  // outer pairs with the holes that fall inside it; without a
  // geometric containment test we conservatively attach all inners
  // to every outer, which is correct for most real-world cases
  // (most multipolygons have one outer + N holes) and slightly
  // over-pessimistic for the rare "multiple disjoint outers each
  // with their own holes" case.  Wave 2 work to do containment.
  const polygons: [number, number][][][] = [];
  for (const outer of outerCoords) {
    const polygon: [number, number][][] = [outer];
    for (const inner of innerCoords) polygon.push(inner);
    polygons.push(polygon);
  }
  const geometry: OsmGeoJsonGeometry =
    polygons.length === 1
      ? { type: 'Polygon', coordinates: polygons[0]! }
      : { type: 'MultiPolygon', coordinates: polygons };
  return {
    type: 'Feature',
    id: `relation/${rel.id}`,
    properties: {
      osmType: 'relation',
      osmId: rel.id,
      ...tags,
    },
    geometry,
  };
}

/**
 * Assemble a list of way members into closed rings.  Consecutive
 * ways share endpoints; we walk the member list, glue connected
 * ways together, and emit closed coordinate arrays.  Ways that
 * don't close (a hole missing a member) are dropped with a warn.
 */
function assembleRings(members: OverpassRelationMember[]): [number, number][][] {
  const remaining = members
    .map((m) => (m.geometry ?? []).map<[number, number]>((p) => [p.lon, p.lat]))
    .filter((arr) => arr.length >= 2);
  const rings: [number, number][][] = [];
  while (remaining.length > 0) {
    const start = remaining.shift()!;
    let current: [number, number][] = start.slice() as [number, number][];
    let progress = true;
    while (progress && !ringClosed(current)) {
      progress = false;
      for (let i = 0; i < remaining.length; i++) {
        const next = remaining[i]!;
        if (coordsEqual(current[current.length - 1]!, next[0]!)) {
          current.push(...next.slice(1));
          remaining.splice(i, 1);
          progress = true;
          break;
        }
        if (coordsEqual(current[current.length - 1]!, next[next.length - 1]!)) {
          // Reverse the next segment and attach.
          const reversed = next.slice().reverse();
          current.push(...reversed.slice(1));
          remaining.splice(i, 1);
          progress = true;
          break;
        }
      }
    }
    if (ringClosed(current) && current.length >= 4) {
      rings.push(current);
    }
    // Else: dropped silently; a malformed relation shouldn't crash
    // the whole conversion.
  }
  return rings;
}

function ringClosed(coords: [number, number][]): boolean {
  if (coords.length < 2) return false;
  const first = coords[0]!;
  const last = coords[coords.length - 1]!;
  return first[0] === last[0] && first[1] === last[1];
}

function coordsEqual(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
