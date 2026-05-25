// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OsmPreset, OsmPresetTag } from './preset-catalog.js';

/**
 * Build a parameterised Overpass QL query from a set of presets +
 * runtime tag filters + a bounding box (#OSM).
 *
 * Output shape:
 *
 *   [out:json][timeout:25];
 *   (
 *     node["amenity"="fuel"]["brand"="Citgo"](south,west,north,east);
 *     way ["amenity"="fuel"]["brand"="Citgo"](south,west,north,east);
 *     rel ["amenity"="fuel"]["brand"="Citgo"](south,west,north,east);
 *     // ... one stanza per (preset, geometry kind) pair
 *   );
 *   out body geom tags;
 *
 * Notes on the shape:
 *
 *   - Each preset emits one stanza per geometry kind it declares
 *     (node / way / relation).  The QL `(...)` block is a union, so
 *     "(gas stations OR EV charging) AND brand=Citgo" comes out as
 *     four+ stanzas all sharing the same trailing tag filter.
 *
 *   - Tag filters from the recipe are concatenated to the preset's
 *     own tag conditions.  All tag filters are ANDed within a
 *     stanza; presets are unioned across stanzas.  v1 ships
 *     equals-only; the `op` field on a filter is accepted but only
 *     `equals` is honoured (contains / regex queued).
 *
 *   - `out body geom tags` includes inline `geometry` coordinates on
 *     ways + relations + node-only `lat`/`lon` -- the converter we
 *     ship in osm-to-geojson.ts depends on this output mode.
 *
 *   - The timeout is `25` (seconds), matching the Overpass default
 *     soft cap.  Big queries that exceed it return a 504 we surface
 *     to the recipe runner; the user retries with a tighter AOI or
 *     filter.
 */

export interface OverpassQlInput {
  presets: OsmPreset[];
  tagFilters?: Array<{ key: string; value: string; op?: 'equals' | 'contains' | 'regex' }>;
  bbox: [west: number, south: number, east: number, north: number];
  /**
   * Per-element soft cap.  Hard-cap at the Overpass server level
   * is configured via the `maxsize` setting on the QL header; we
   * raise it modestly above the default so the typical
   * "restaurants in a city" query doesn't 414 out, but stay well
   * under what would burn the public-server quota in a single
   * call.  Defaults to 50000.
   */
  maxFeatures?: number;
  /** Per-query timeout in seconds; defaults to 25. */
  timeoutSeconds?: number;
}

/** Escape a tag value for inclusion inside an Overpass tag clause.
 *  Overpass uses double-quoted strings inside its tag selectors;
 *  we escape backslashes + quotes per RFC and reject control bytes
 *  so a tag value can't break out of the clause. */
export function escapeOverpassTagValue(raw: string): string {
  // Reject control + line terminators.  The QL spec disallows
  // them inside quoted strings and an injection attempt would
  // need one to break out.  Charcode check rather than a regex
  // with literal control escapes so ESLint's no-control-regex
  // doesn't flag the guard.
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x20) {
      throw new Error('OSM tag value contains control characters');
    }
  }
  return raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Same escape rules for keys.  Overpass keys are stricter
 *  (alpha / digit / underscore / colon) but we keep the same
 *  escape to defend the QL generator against future schema
 *  weirdness. */
export function escapeOverpassTagKey(raw: string): string {
  if (!/^[a-zA-Z0-9_:.-]+$/.test(raw)) {
    throw new Error(`OSM tag key contains unsupported characters: ${raw}`);
  }
  return raw;
}

/**
 * Render one tag selector clause, e.g. `["amenity"="fuel"]`.  When
 * the preset value is the wildcard `"*"` we emit a presence-only
 * clause (`["amenity"]`) -- iD uses `*` to mean "any value for this
 * key".
 */
function tagClause(tag: OsmPresetTag | { key: string; value: string }): string {
  const k = escapeOverpassTagKey(tag.key);
  if (tag.value === '*') {
    return `["${k}"]`;
  }
  const v = escapeOverpassTagValue(tag.value);
  return `["${k}"="${v}"]`;
}

/**
 * Render the per-stanza tag block: the preset's own tags + the
 * runtime tag filters, all ANDed.  Filters with op !== 'equals'
 * are accepted but ignored in v1 to keep the QL deterministic;
 * a follow-up adds the regex / contains operators.
 */
function combinedTags(
  preset: OsmPreset,
  filters: OverpassQlInput['tagFilters'],
): string {
  const parts: string[] = [];
  for (const t of preset.tags) parts.push(tagClause(t));
  if (filters) {
    for (const f of filters) {
      if (f.op && f.op !== 'equals') continue; // v1 equals-only
      parts.push(tagClause({ key: f.key, value: f.value }));
    }
  }
  return parts.join('');
}

/**
 * Build the full QL string.  Throws when:
 *   - the presets array is empty (nothing to query)
 *   - bbox is malformed (south >= north or west >= east, or values
 *     outside the geographic range)
 *   - any preset's tag set escape fails (a defensive check; the
 *     vendored catalog is sanitised at sync time)
 */
export function buildOverpassQl(input: OverpassQlInput): string {
  if (!input.presets || input.presets.length === 0) {
    throw new Error('buildOverpassQl: at least one preset is required');
  }
  const [w, s, e, n] = input.bbox;
  if (![w, s, e, n].every((x) => Number.isFinite(x))) {
    throw new Error('buildOverpassQl: bbox values must be finite numbers');
  }
  if (w >= e || s >= n) {
    throw new Error(
      `buildOverpassQl: bbox is degenerate (west=${w} >= east=${e} or south=${s} >= north=${n})`,
    );
  }
  if (w < -180 || e > 180 || s < -90 || n > 90) {
    throw new Error('buildOverpassQl: bbox is outside the geographic range');
  }

  const timeout = input.timeoutSeconds ?? 25;
  const maxsize = (input.maxFeatures ?? 50000) * 1024; // bytes; rough
  // Overpass bbox order is (south,west,north,east).
  const bbox = `(${s},${w},${n},${e})`;

  const stanzas: string[] = [];
  for (const preset of input.presets) {
    const tags = combinedTags(preset, input.tagFilters);
    for (const geom of preset.geometries) {
      const keyword =
        geom === 'node'
          ? 'node'
          : geom === 'way'
            ? 'way'
            : 'relation';
      stanzas.push(`  ${keyword}${tags}${bbox};`);
    }
  }

  return [
    `[out:json][timeout:${timeout}][maxsize:${maxsize}];`,
    `(`,
    ...stanzas,
    `);`,
    `out body geom tags;`,
  ].join('\n');
}
