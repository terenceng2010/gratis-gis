// SPDX-License-Identifier: AGPL-3.0-or-later
import { Pool, type PoolClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

import { cellForGeometry, uuidv7, type Observation } from '@gratis-gis/engine';

/**
 * COPY-based bulk writer for the observation table (#115 P3).
 *
 * Why this exists separately from EngineService.writeMany:
 *
 * The streaming-INSERT path through Prisma's $executeRawUnsafe goes
 * through the SQL parser, parameter binder, and protocol round-trip
 * for every batch. For an online write of one or two rows, that
 * overhead is a rounding error. For a million-row import, it's
 * minutes of wall clock spent in the pipe rather than the disk.
 *
 * `COPY ... FROM STDIN` is PostgreSQL's bulk-load wire protocol. We
 * stream rows as TEXT-format CSV-ish lines (tab separators, \\N for
 * null, geometry as EWKT so PostGIS parses on input) and the server
 * applies them with no per-row SQL parsing. Empirically 5-10x
 * faster than batched multi-row INSERTs for large imports.
 *
 * Caveats:
 *   - We open a separate pg connection (pg-copy-streams needs the
 *     raw client; Prisma doesn't expose its underlying pool). The
 *     connection is short-lived: opened at the start of a job,
 *     closed at the end.
 *   - Geometry is encoded as EWKT (`SRID=4326;POINT (...)`),
 *     skipping ST_GeomFromGeoJSON entirely. PostGIS parses EWKT
 *     considerably faster than GeoJSON.
 *   - The `cell` h3 index is computed JS-side from the geometry
 *     and shipped as a literal column value. This is the same
 *     work the engine.service writeMany did; once the cell is
 *     promoted to a generated column (#115 P4) the JS-side call
 *     drops out.
 *   - This path bypasses derived-layer cache invalidation
 *     (notifySourceWrite). The worker fires a single bulk
 *     invalidation after the COPY completes -- cheaper than
 *     N per-row calls and good enough for the staleness window
 *     between import-finished and the next regular write.
 */
export class CopyWriter {
  private pool: Pool;
  private client: PoolClient | null = null;
  private stream: NodeJS.WritableStream | null = null;
  private rowCount = 0;

  constructor(databaseUrl: string) {
    // Single-use pool sized to one connection. The worker's
    // job-lifecycle owns this writer and we don't need
    // concurrency. min=0 so the connection closes cleanly when
    // the pool ends.
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      min: 0,
    });
  }

  async start(): Promise<void> {
    this.client = await this.pool.connect();
    // SET LOCAL synchronous_commit=off for this transaction.
    // Bulk imports are re-runnable; trading per-commit fsync
    // durability for ~20-30% throughput is the right call here.
    // The setting reverts at transaction end so other queries on
    // the same client (none in this design) get default behavior.
    await this.client.query('BEGIN');
    await this.client.query('SET LOCAL synchronous_commit = OFF');
    const sql =
      'COPY observation (' +
      [
        'id',
        'tx_time',
        'valid_from',
        'valid_to',
        'scope',
        'entity',
        'kind',
        'attrs',
        'geom',
        'cell',
        'author_sub',
        'source',
        'parents',
      ].join(', ') +
      ') FROM STDIN WITH (FORMAT text)';
    this.stream = this.client.query(copyFrom(sql)) as unknown as
      NodeJS.WritableStream;
  }

  /**
   * Write one observation row. Caller must have invoked start()
   * first. The row is encoded as PostgreSQL's TEXT-format COPY
   * line: tab-separated fields, terminated with newline, with the
   * documented backslash-escape rules for embedded special chars.
   *
   * Geometry: emitted as EWKT with SRID=4326 prefix when present;
   * \\N (null) otherwise. PostGIS recognizes EWKT on COPY-in.
   *
   * Attrs / source: emitted as compact JSON. PostgreSQL's jsonb
   * input parser handles the COPY-escaped form transparently.
   */
  write(obs: Observation): void {
    if (!this.stream) {
      throw new Error('CopyWriter.write called before start().');
    }
    const id = obs.id ?? uuidv7();
    const cell = obs.cell ?? cellForGeometry(obs.geom);
    const cells: string[] = [
      escapeText(id),
      escapeText(obs.txTime?.toISOString() ?? new Date().toISOString()),
      escapeText(obs.validFrom.toISOString()),
      obs.validTo === null
        ? '\\N'
        : escapeText(obs.validTo.toISOString()),
      escapeText(obs.scope),
      escapeText(obs.entity),
      escapeText(obs.kind),
      obs.attrs === null ? '\\N' : escapeText(JSON.stringify(obs.attrs)),
      obs.geom === null
        ? '\\N'
        : escapeText(geomToEwkt(obs.geom)),
      cell === null ? '\\N' : escapeText(cell),
      escapeText(obs.author.sub),
      escapeText(JSON.stringify(obs.source)),
      // uuid[] in COPY text format: '{a,b,c}' literal. Empty
      // array is '{}'. Escape because braces and commas are
      // text-COPY meta in some contexts (they're not for arrays
      // specifically, but escapeText is a no-op for safe text).
      escapeText(`{${obs.parents.join(',')}}`),
    ];
    this.stream.write(cells.join('\t') + '\n');
    this.rowCount += 1;
  }

  /**
   * Close the COPY stream and commit the transaction. Returns the
   * number of rows written. Errors during stream-end or commit
   * roll back the transaction, so a partially-streamed batch
   * never lands.
   */
  async end(): Promise<number> {
    if (!this.stream || !this.client) {
      throw new Error('CopyWriter.end called before start().');
    }
    const stream = this.stream;
    await new Promise<void>((resolve, reject) => {
      stream.on('finish', () => resolve());
      stream.on('error', reject);
      stream.end();
    });
    await this.client.query('COMMIT');
    this.client.release();
    this.client = null;
    this.stream = null;
    return this.rowCount;
  }

  /** Abort the in-flight COPY and roll back. Call from a finally
   *  branch when the caller throws mid-write so the connection
   *  isn't leaked back to the pool with an open transaction. */
  async abort(): Promise<void> {
    try {
      if (this.client) {
        await this.client.query('ROLLBACK');
      }
    } catch {
      // Best-effort; nothing to do if the transaction is already
      // dead.
    } finally {
      this.client?.release();
      this.client = null;
      this.stream = null;
    }
  }

  /** Tear down the pool when the worker is done with this writer.
   *  Important so process shutdown doesn't hang on an open pool. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Escape a value for COPY's TEXT format per the PostgreSQL docs:
 *   https://www.postgresql.org/docs/current/sql-copy.html
 *
 * Backslash and newline / tab / carriage-return need to be
 * escaped; everything else passes through. NUL never appears in
 * our data so we don't need to worry about it.
 */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Convert a GeoJSON geometry to PostGIS EWKT with SRID=4326.
 * Hand-rolled rather than depending on a WKT lib because we own
 * the geometry types we produce (Point/LineString/Polygon and
 * their Multi- variants, with optional Z). EWKT lets PostGIS skip
 * the JSON parser entirely; on a million-row import this is the
 * second-biggest perf lever after COPY itself.
 */
function geomToEwkt(g: unknown): string {
  if (!g || typeof g !== 'object') return '';
  const obj = g as { type?: string; coordinates?: unknown };
  const t = obj.type;
  const c = obj.coordinates;
  if (!t || c === undefined) return '';
  // Detect Z: any coordinate triple where the third element is a
  // finite number signals 3D. We trust GDAL to emit consistent
  // dimensionality per geometry; if a polygon's outer ring is
  // 3D, all rings are.
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
    // We're at the leaf coordinate level (Point shape).
    return c.length >= 3 && typeof c[2] === 'number';
  }
  return detectZ(first);
}

function pointToWkt(c: unknown, hasZ: boolean): string {
  if (!Array.isArray(c) || c.length < 2) return '';
  if (hasZ && typeof c[2] === 'number') {
    return `${c[0]} ${c[1]} ${c[2]}`;
  }
  return `${c[0]} ${c[1]}`;
}

function ringToWkt(c: unknown, hasZ: boolean): string {
  if (!Array.isArray(c)) return '';
  return c.map((p) => pointToWkt(p, hasZ)).join(', ');
}

function polygonRingsToWkt(c: unknown, hasZ: boolean): string {
  if (!Array.isArray(c)) return '';
  return c.map((ring) => `(${ringToWkt(ring, hasZ)})`).join(', ');
}

function multiLineToWkt(c: unknown, hasZ: boolean): string {
  if (!Array.isArray(c)) return '';
  return c.map((line) => `(${ringToWkt(line, hasZ)})`).join(', ');
}

function multiPolygonToWkt(c: unknown, hasZ: boolean): string {
  if (!Array.isArray(c)) return '';
  return c
    .map((poly) => `(${polygonRingsToWkt(poly, hasZ)})`)
    .join(', ');
}
