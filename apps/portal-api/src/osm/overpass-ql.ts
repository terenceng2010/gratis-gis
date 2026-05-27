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
 *
 * The `op` field selects between three Overpass operators:
 *
 *   - `equals` (default):    `["key"="value"]` -- exact match.
 *   - `contains`:            `["key"~"<escaped>",i]` -- case-
 *                            insensitive substring match.  User
 *                            input is escaped as a regex literal
 *                            so a `.` in the search string matches
 *                            a literal `.`, not "any character."
 *   - `regex`:               `["key"~"<raw>"]` -- user-supplied
 *                            regex (case-sensitive).  Caller is
 *                            responsible for the pattern shape;
 *                            Overpass's per-query timeout caps any
 *                            catastrophic-backtracking exposure.
 */
function tagClause(
  tag:
    | OsmPresetTag
    | { key: string; value: string; op?: 'equals' | 'contains' | 'regex' },
): string {
  const k = escapeOverpassTagKey(tag.key);
  if (tag.value === '*') {
    return `["${k}"]`;
  }
  const op = 'op' in tag ? tag.op : undefined;
  if (op === 'contains') {
    const escapedLiteral = escapeRegexLiteral(tag.value);
    const v = escapeOverpassTagValue(escapedLiteral);
    return `["${k}"~"${v}",i]`;
  }
  if (op === 'regex') {
    const v = escapeOverpassTagValue(tag.value);
    return `["${k}"~"${v}"]`;
  }
  const v = escapeOverpassTagValue(tag.value);
  return `["${k}"="${v}"]`;
}

/**
 * Escape regex metacharacters in a user-supplied literal so the
 * resulting regex matches the input as a plain substring.  The
 * set covers the ECMAScript metachar list; Overpass uses POSIX
 * extended regex on top of which `i` switches case-insensitive.
 * Backslashes are doubled here too because the QL value escape
 * step (escapeOverpassTagValue) then doubles them again to satisfy
 * the QL string-literal grammar.
 */
function escapeRegexLiteral(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Render the per-stanza tag block: the preset's own tags + the
 * runtime tag filters, all ANDed.  Filters honor the `equals` /
 * `contains` / `regex` op selector; see tagClause() for the per-op
 * Overpass semantics.
 */
function combinedTags(
  preset: OsmPreset,
  filters: OverpassQlInput['tagFilters'],
): string {
  const parts: string[] = [];
  for (const t of preset.tags) parts.push(tagClause(t));
  if (filters) {
    for (const f of filters) {
      parts.push(tagClause(f));
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

/**
 * Input shape for the relational query builder (#142).  Anchor +
 * one or more conditions, each carrying a meters distance for the
 * Overpass `around:` predicate.  Bbox bounds the anchor scan; the
 * around-based per-condition filters are bounded by the anchor set
 * itself, so we don't double up on bbox limits downstream.
 */
export interface RelationalOverpassQlInput {
  anchor: OsmPreset;
  /** Per-condition: preset + distance threshold in meters. */
  conditions: Array<{ preset: OsmPreset; distanceMeters: number }>;
  bbox: [west: number, south: number, east: number, north: number];
  maxFeatures?: number;
  /** Per-query Overpass timeout in seconds; defaults to 60.  The
   *  relational query touches more sets than a flat preset query so
   *  60s is a more realistic ceiling than buildOverpassQl's 25. */
  timeoutSeconds?: number;
}

/**
 * Build a single Overpass QL query that runs the entire relational
 * predicate in one round-trip, using Overpass's native `around:set`
 * filter.  Returns features in THREE labeled output statements:
 *
 *   - the surviving anchors (those that have at least one feature
 *     of every condition within distance),
 *   - the supporting features for each condition (condition
 *     features that are within distance of at least one survivor).
 *
 * The caller classifies returned features by checking which
 * preset's tag selector each feature matches.  This is much more
 * efficient than fetching anchors + conditions separately and
 * doing per-pair ST_DWithin in PostGIS: Overpass's spatial index
 * handles the join in one pass on a server purpose-built for it.
 */
export function buildRelationalOverpassQl(
  input: RelationalOverpassQlInput,
): string {
  if (!input.anchor) {
    throw new Error('buildRelationalOverpassQl: anchor preset is required');
  }
  if (!input.conditions || input.conditions.length === 0) {
    throw new Error(
      'buildRelationalOverpassQl: at least one condition is required (otherwise use buildOverpassQl)',
    );
  }
  const [w, s, e, n] = input.bbox;
  if (![w, s, e, n].every((x) => Number.isFinite(x))) {
    throw new Error('buildRelationalOverpassQl: bbox values must be finite numbers');
  }
  if (w >= e || s >= n) {
    throw new Error(
      `buildRelationalOverpassQl: bbox is degenerate (west=${w} >= east=${e} or south=${s} >= north=${n})`,
    );
  }
  if (w < -180 || e > 180 || s < -90 || n > 90) {
    throw new Error('buildRelationalOverpassQl: bbox is outside the geographic range');
  }
  const timeout = input.timeoutSeconds ?? 60;
  const maxsize = (input.maxFeatures ?? 50000) * 1024; // rough byte budget
  const bbox = `(${s},${w},${n},${e})`;

  // Emit the standard "(node|way|relation)<tag-block><filter>" trio
  // for a preset.  `filterBlock` is whatever bounding filter
  // applies (bbox for the anchor, `(around.set:distance)` for the
  // narrowed sets).  Tag block comes from the preset's own tags;
  // tag filters from the recipe aren't supported in v1 of the
  // relational surface (the existing OsmFeatureParameter shape
  // is the place those land for the simple preset query).
  const stanza = (preset: OsmPreset, filterBlock: string): string => {
    const tags = combinedTags(preset, undefined);
    const lines: string[] = [];
    for (const geom of preset.geometries) {
      const keyword =
        geom === 'node' ? 'node' : geom === 'way' ? 'way' : 'relation';
      lines.push(`    ${keyword}${tags}${filterBlock};`);
    }
    return lines.join('\n');
  };

  // Round distances to integer meters: Overpass accepts decimals,
  // but integer ensures bit-for-bit reproducibility across cache
  // hits and keeps the QL terse.
  const conditionDistances = input.conditions.map((c) =>
    Math.max(1, Math.round(c.distanceMeters)),
  );

  const lines: string[] = [];
  lines.push(`[out:json][timeout:${timeout}][maxsize:${maxsize}];`);
  // Anchor candidates: presets matching anchor inside the bbox.
  lines.push(`// Anchor candidates inside the AOI bbox`);
  lines.push(`(`);
  lines.push(stanza(input.anchor, bbox));
  lines.push(`)->.anchors;`);
  // Per-condition prefilter: condition features within distance of
  // any anchor candidate.  Narrows the search space before the
  // survivor check below.
  for (let i = 0; i < input.conditions.length; i++) {
    const c = input.conditions[i]!;
    const d = conditionDistances[i]!;
    lines.push(`// Condition ${i}: features within ${d}m of any anchor`);
    lines.push(`(`);
    lines.push(stanza(c.preset, `(around.anchors:${d})`));
    lines.push(`)->.cond${i};`);
  }
  // Survivor selection: anchors within distance of at least one
  // feature in EVERY condition set (Overpass ANDs chained around
  // filters automatically).
  const survivorFilter = input.conditions
    .map((_, i) => `(around.cond${i}:${conditionDistances[i]})`)
    .join('');
  lines.push(`// Surviving anchors: pass all condition distance checks`);
  lines.push(`(`);
  lines.push(stanza(input.anchor, survivorFilter));
  lines.push(`)->.survivors;`);
  // Supporting features per condition: those near at least one
  // surviving anchor.  Re-narrows the prefilter sets to the truly
  // relevant ones the client will render.
  for (let i = 0; i < input.conditions.length; i++) {
    const c = input.conditions[i]!;
    const d = conditionDistances[i]!;
    lines.push(`// Supporting features for condition ${i}`);
    lines.push(`(`);
    lines.push(stanza(c.preset, `(around.survivors:${d})`));
    lines.push(`)->.supporting${i};`);
  }
  // Single output statement per labeled set so the caller can
  // distinguish the three groups by either parsing the @id ranges
  // or (more robustly) re-classifying via tag-selector match
  // against the preset definitions.
  lines.push(`.survivors out body geom tags;`);
  for (let i = 0; i < input.conditions.length; i++) {
    lines.push(`.supporting${i} out body geom tags;`);
  }
  return lines.join('\n');
}
