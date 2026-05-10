// SPDX-License-Identifier: AGPL-3.0-or-later
// COPY-line encoder running in a Node worker_thread (#115 P9).
//
// Why this exists: encoding observation rows to PostgreSQL TEXT-format
// COPY lines is CPU-bound JS work -- per-coordinate template literals
// for EWKT, JSON.stringify on the attrs object, and four regex passes
// in escapeText. On a county-scale parcel dataset (1.4M complex
// polygons, some with tens of thousands of vertices) this saturates
// one CPU core for many minutes. With the encoder on the main thread
// of portal-worker, the GDAL feature pump and the pg-copy-streams
// writer were forced to run sequentially with the encoder, and the
// COPY stream stalled while the JS thread was busy serializing.
//
// Putting the encoder in a worker_thread runs it on a different CPU
// core. The main thread's job becomes:
//   1. Pump GDAL features (synchronous C++ calls, fast).
//   2. postMessage(batch) to this worker.
//   3. Receive the encoded multi-line string.
//   4. Write it to the COPY stream (also fast; pg-copy-streams just
//      pushes bytes to a TCP socket).
//
// On a multi-core host the encoder and the GDAL pump overlap, so the
// throughput ceiling is whichever side is slower in isolation rather
// than their sum. Empirically the encoder is the bottleneck, so this
// is roughly a 2x improvement on big-polygon datasets.

import { parentPort } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('copy-encoder.worker must be loaded via Worker.');
}

interface EncodeRequest {
  type: 'encode';
  id: number;
  batch: ObservationLike[];
}

interface ObservationLike {
  id?: string;
  txTime?: Date | string;
  validFrom: Date | string;
  validTo: Date | string | null;
  scope: string;
  entity: string;
  kind: string;
  attrs: Record<string, unknown> | null;
  geom: unknown;
  cell?: string | null;
  author: { sub: string; displayName?: string };
  source: unknown;
  parents: string[];
}

parentPort.on('message', (msg: EncodeRequest) => {
  if (msg.type !== 'encode') return;
  try {
    const lines = encodeBatch(msg.batch);
    parentPort!.postMessage({ type: 'encoded', id: msg.id, lines });
  } catch (err) {
    parentPort!.postMessage({
      type: 'error',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

function encodeBatch(batch: ObservationLike[]): string {
  // Build into a single string with a buffer-like array. V8 is good
  // at optimizing this pattern for large outputs.
  const parts: string[] = new Array(batch.length);
  for (let i = 0; i < batch.length; i += 1) {
    parts[i] = encodeRow(batch[i]!);
  }
  return parts.join('');
}

function encodeRow(obs: ObservationLike): string {
  // Inline-stringify each column straight into a tab-joined line.
  // This is the hot path; minimize allocations.
  const id = obs.id ?? uuidv7();
  const txTimeStr = toIsoString(obs.txTime ?? new Date());
  const validFromStr = toIsoString(obs.validFrom);
  const validToStr = obs.validTo === null ? '\\N' : escapeText(toIsoString(obs.validTo));
  const cellStr = obs.cell == null ? '\\N' : escapeText(obs.cell);
  const attrsStr = obs.attrs === null ? '\\N' : escapeText(JSON.stringify(obs.attrs));
  const geomStr = obs.geom == null ? '\\N' : geomToEwkt(obs.geom);
  const sourceStr = escapeText(JSON.stringify(obs.source));
  const parentsStr = `{${obs.parents.join(',')}}`;
  // Tab-separate, newline-terminate. Coordinates and SRID prefixes
  // never contain tab/newline/backslash so geomStr skips escapeText
  // entirely (saves ~4 regex passes per row, which is non-trivial
  // for 50000-vertex polygons).
  return (
    id +
    '\t' +
    escapeText(txTimeStr) +
    '\t' +
    escapeText(validFromStr) +
    '\t' +
    validToStr +
    '\t' +
    escapeText(obs.scope) +
    '\t' +
    obs.entity +
    '\t' +
    escapeText(obs.kind) +
    '\t' +
    attrsStr +
    '\t' +
    geomStr +
    '\t' +
    cellStr +
    '\t' +
    escapeText(obs.author.sub) +
    '\t' +
    sourceStr +
    '\t' +
    parentsStr +
    '\n'
  );
}

function toIsoString(d: Date | string): string {
  if (typeof d === 'string') return d;
  return d.toISOString();
}

/** PostgreSQL TEXT-format COPY escaping. */
function escapeText(s: string): string {
  // Fast path: most strings have none of these chars. Check before
  // allocating a new string. Saves ~30% on the escape pass for
  // attribute values that are plain ascii.
  if (
    s.indexOf('\\') === -1 &&
    s.indexOf('\t') === -1 &&
    s.indexOf('\n') === -1 &&
    s.indexOf('\r') === -1
  ) {
    return s;
  }
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Hand-rolled GeoJSON-to-EWKT converter. Skips the regex-based
 * escapeText because numeric coordinates and the SRID prefix never
 * contain COPY meta-characters. This shaves a meaningful chunk off
 * the bigger polygons.
 */
function geomToEwkt(g: unknown): string {
  if (!g || typeof g !== 'object') return '';
  const obj = g as { type?: string; coordinates?: unknown };
  const t = obj.type;
  const c = obj.coordinates;
  if (!t || c === undefined) return '';
  const hasZ = detectZ(c);
  const dimTag = hasZ ? ' Z' : '';
  switch (t) {
    case 'Point':
      return `SRID=4326;POINT${dimTag}(${pointToWkt(c, hasZ)})`;
    case 'LineString':
      return `SRID=4326;LINESTRING${dimTag}(${ringToWkt(c, hasZ)})`;
    case 'Polygon':
      return `SRID=4326;POLYGON${dimTag}(${polygonRingsToWkt(c, hasZ)})`;
    case 'MultiPoint':
      return `SRID=4326;MULTIPOINT${dimTag}(${ringToWkt(c, hasZ)})`;
    case 'MultiLineString':
      return `SRID=4326;MULTILINESTRING${dimTag}(${multiLineToWkt(c, hasZ)})`;
    case 'MultiPolygon':
      return `SRID=4326;MULTIPOLYGON${dimTag}(${multiPolygonToWkt(c, hasZ)})`;
    default:
      return '';
  }
}

function detectZ(c: unknown): boolean {
  if (!Array.isArray(c) || c.length === 0) return false;
  const first = c[0];
  if (typeof first === 'number') {
    return c.length >= 3 && typeof c[2] === 'number';
  }
  return detectZ(first);
}

function pointToWkt(c: unknown, hasZ: boolean): string {
  if (!Array.isArray(c) || c.length < 2) return '';
  // String concatenation is faster than template literals in V8 for
  // hot paths (template literals allocate a tagged-template tuple
  // even for the simple form). Each polygon vertex hits this; on a
  // 50000-vertex polygon the difference adds up.
  if (hasZ && typeof c[2] === 'number') {
    return c[0] + ' ' + c[1] + ' ' + c[2];
  }
  return c[0] + ' ' + c[1];
}

function ringToWkt(c: unknown, hasZ: boolean): string {
  if (!Array.isArray(c)) return '';
  // Hand-coded loop instead of .map().join() to avoid the
  // intermediate array allocation for very large rings.
  let out = '';
  for (let i = 0; i < c.length; i += 1) {
    if (i > 0) out += ', ';
    out += pointToWkt(c[i], hasZ);
  }
  return out;
}

function polygonRingsToWkt(c: unknown, hasZ: boolean): string {
  if (!Array.isArray(c)) return '';
  let out = '';
  for (let i = 0; i < c.length; i += 1) {
    if (i > 0) out += ', ';
    out += '(' + ringToWkt(c[i], hasZ) + ')';
  }
  return out;
}

function multiLineToWkt(c: unknown, hasZ: boolean): string {
  if (!Array.isArray(c)) return '';
  let out = '';
  for (let i = 0; i < c.length; i += 1) {
    if (i > 0) out += ', ';
    out += '(' + ringToWkt(c[i], hasZ) + ')';
  }
  return out;
}

function multiPolygonToWkt(c: unknown, hasZ: boolean): string {
  if (!Array.isArray(c)) return '';
  let out = '';
  for (let i = 0; i < c.length; i += 1) {
    if (i > 0) out += ', ';
    out += '(' + polygonRingsToWkt(c[i], hasZ) + ')';
  }
  return out;
}

/**
 * Local UUIDv7. The main thread normally fills this in via the
 * engine package's helper, but if a caller skips it we fall back
 * here so the worker is self-contained and we don't postMessage
 * an extra import-graph dependency.
 *
 * Format: 48-bit unix-millis timestamp + 12 random bits + version
 * (4) + variant (2) + 62 random bits.
 */
function uuidv7(): string {
  const ms = Date.now();
  const tsHigh = Math.floor(ms / 0x100000000);
  const tsLow = ms >>> 0;
  const r1 = Math.floor(Math.random() * 0x10000);
  const r2 = Math.floor(Math.random() * 0x10000);
  const r3 = Math.floor(Math.random() * 0x10000);
  const r4 = Math.floor(Math.random() * 0x10000);
  const r5 = Math.floor(Math.random() * 0x10000);

  // unixts (48 bits) + ver (4) + rand_a (12) + var (2) + rand_b (62)
  const hex = (n: number, w: number) => n.toString(16).padStart(w, '0');
  const verAndRand = (0x7000 | (r1 & 0x0fff)).toString(16).padStart(4, '0');
  const varAndRand = (0x8000 | (r2 & 0x3fff)).toString(16).padStart(4, '0');
  return (
    hex(tsHigh, 4) +
    hex(tsLow, 8).slice(0, 4) +
    '-' +
    hex(tsLow, 8).slice(4) +
    '-' +
    verAndRand +
    '-' +
    varAndRand +
    '-' +
    hex(r3, 4) +
    hex(r4, 4) +
    hex(r5, 4)
  );
}
