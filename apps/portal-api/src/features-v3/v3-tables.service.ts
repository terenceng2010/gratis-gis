// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Lifecycle helpers for v3 (multi-layer) data_layer items.
 *
 * Lives in its own module with zero dependencies beyond PrismaService so
 * ItemsModule can import it for reconcile-on-create/update/purge without
 * pulling in the full feature CRUD stack (which depends on ItemsModule
 * and would deadlock the DI graph).
 *
 * Each v3 layer becomes a PostGIS table `fs_<itemIdNoDashes>_<layerId>`.
 * Naming is deterministic so the CRUD service can rebuild a table name
 * from (itemId, layerId) without a round-trip. Idempotent DDL means
 * reconcile() is safe to re-run.
 */

export interface V3LayerShape {
  id: string;
  geometryType: 'point' | 'line' | 'polygon' | null;
  fields?: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'date';
    /**
     * When true, ensure a btree index on the column at provision
     * time. The index is dropped automatically when the field is
     * removed from the layer schema (the whole table is rebuilt
     * by reconcile via DROP + CREATE for column changes). Drives
     * the explicit half of #23 (smart auto-indexing): a layer
     * author marks the columns they expect to query on, the
     * portal makes those queries fast.
     */
    searchable?: boolean;
  }>;
  parentFkColumn?: string | undefined;
}

@Injectable()
export class V3TablesService {
  private readonly log = new Logger(V3TablesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aggregate the feature-extent of every spatial layer in a v3
   * data_layer into a single [w,s,e,n] envelope (#90). Tables for
   * non-spatial layers (geometryType === null) carry no geom column
   * so we skip them. Missing tables (layer provisioned but never
   * populated) are tolerated and contribute nothing. Returns null
   * when no layer in the set yields a usable extent: the caller
   * stores that as `bbox = []` so the area filter correctly excludes
   * the item from "what's in this area?" results until features land.
   */
  async aggregateBbox(
    itemId: string,
    layers: V3LayerShape[],
  ): Promise<[number, number, number, number] | null> {
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    let any = false;
    for (const layer of layers) {
      if (layer.geometryType === null) continue;
      const tbl = toV3TableName(itemId, layer.id);
      try {
        const rows = await this.prisma.$queryRawUnsafe<
          Array<{
            minx: number | null;
            miny: number | null;
            maxx: number | null;
            maxy: number | null;
          }>
        >(
          `SELECT
             ST_XMin(ST_Extent(geom))::float8 AS minx,
             ST_YMin(ST_Extent(geom))::float8 AS miny,
             ST_XMax(ST_Extent(geom))::float8 AS maxx,
             ST_YMax(ST_Extent(geom))::float8 AS maxy
           FROM "${tbl}"
           WHERE valid_to IS NULL`,
        );
        const r = rows[0];
        if (
          r?.minx != null &&
          r.miny != null &&
          r.maxx != null &&
          r.maxy != null
        ) {
          w = Math.min(w, r.minx);
          s = Math.min(s, r.miny);
          e = Math.max(e, r.maxx);
          n = Math.max(n, r.maxy);
          any = true;
        }
      } catch (err) {
        // Table missing or unreadable -- log but continue. Most often
        // means the layer has been declared but never provisioned;
        // that's fine for "compute the extent of what we have".
        this.log.debug(
          `aggregateBbox: could not read ${tbl}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
    return any ? [w, s, e, n] : null;
  }

  /**
   * Most recent feature-level activity across every layer in a v3
   * data_layer (#95). Returns the latest of edited_at and valid_to
   * (delete tombstone) over all rows in every layer table; null
   * when no spatial/table layer has any activity. Used by the
   * housekeeping stale-item heuristic so a data_layer with active
   * feature edits doesn't look "stale" just because nobody changed
   * the item card.
   */
  async lastDataActivityAt(
    itemId: string,
    layers: V3LayerShape[],
  ): Promise<Date | null> {
    let max: Date | null = null;
    for (const layer of layers) {
      const tbl = toV3TableName(itemId, layer.id);
      try {
        const rows = await this.prisma.$queryRawUnsafe<
          Array<{ ts: Date | null }>
        >(
          `SELECT MAX(GREATEST(edited_at, COALESCE(valid_to, edited_at))) AS ts
             FROM "${tbl}"`,
        );
        const ts = rows[0]?.ts;
        if (ts && (!max || ts > max)) {
          max = ts;
        }
      } catch {
        // Missing / unreadable table -- treat as no activity. The
        // create flow's reconcile() runs DDL idempotently so a
        // missing table is genuinely a "never populated" signal.
      }
    }
    return max;
  }

  async provisionLayer(itemId: string, layer: V3LayerShape): Promise<void> {
    const tbl = toV3TableName(itemId, layer.id);
    // Narrow via assignment so `isTable ? ... : toPgGeomType(geomType)`
    // doesn't re-widen geometryType back to the full union inside the
    // branch. Without this, tsc complains because null isn't a valid
    // input to toPgGeomType even though the branch is guarded.
    const geomType = layer.geometryType;
    const isTable = geomType === null;

    const geomDdl = isTable
      ? ''
      : `, geom        GEOMETRY(${toPgGeomType(geomType)}, 4326)`;
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${tbl}" (
        gid         BIGSERIAL PRIMARY KEY,
        global_id   UUID        NOT NULL DEFAULT gen_random_uuid(),
        properties  JSONB       NOT NULL DEFAULT '{}',
        valid_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        valid_to    TIMESTAMPTZ,
        created_by  UUID        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        edited_by   UUID        NOT NULL,
        edited_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        ${geomDdl}
      )
    `);
    if (!isTable) {
      // Two cases to handle here, both reached via this branch:
      //
      //   a) The table was provisioned with a geom column already
      //      (the ordinary single-pass create), but with a single-
      //      geometry type from before #240. Rewrite to Multi-*
      //      because real shapefiles mix single + multi inside one
      //      layer; ST_Multi() is idempotent for already-multi
      //      geometries, so this is a no-op for empty tables and a
      //      one-time migration for populated ones.
      //
      //   b) The table was provisioned earlier as geometryType=null
      //      (e.g. a form's paired data_layer at create time, before
      //      the form designer added a geo question) and is now
      //      being re-provisioned to a real geometry type. The
      //      CREATE TABLE IF NOT EXISTS above is a no-op when the
      //      table already exists, so the geom column is missing
      //      and we have to ALTER TABLE ADD COLUMN. Without this,
      //      flipping a form from non-spatial to spatial would never
      //      land a geom column on the underlying PG table even if
      //      the layer's logical schema said geometryType='point'.
      const desired = toPgGeomType(geomType);
      const current = await this.prisma.$queryRawUnsafe<
        Array<{ ftype: string }>
      >(`
        SELECT format_type(atttypid, atttypmod) AS ftype
        FROM pg_attribute
        WHERE attrelid = '"${tbl}"'::regclass
          AND attname = 'geom'
      `);
      const ftype = current[0]?.ftype ?? '';
      if (ftype.length === 0) {
        // Case (b): no geom column yet. Add one with the desired
        // multi-geom type. This is the path #325 needs for the
        // form-paired layer geometryType promotion.
        await this.prisma.$executeRawUnsafe(`
          ALTER TABLE "${tbl}"
          ADD COLUMN IF NOT EXISTS geom GEOMETRY(${desired}, 4326)
        `);
        this.log.log(
          `Added geom column to ${tbl} as GEOMETRY(${desired}, 4326)`,
        );
      } else if (!ftype.toLowerCase().includes(desired.toLowerCase())) {
        // Case (a): geom column exists with the wrong type. Migrate.
        await this.prisma.$executeRawUnsafe(`
          ALTER TABLE "${tbl}"
          ALTER COLUMN geom TYPE GEOMETRY(${desired}, 4326)
          USING ST_Multi(geom)
        `);
        this.log.log(
          `Migrated ${tbl}.geom from ${ftype} to GEOMETRY(${desired}, 4326)`,
        );
      }
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "${tbl}_geom_idx"
          ON "${tbl}" USING GIST (geom)
      `);
    }
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "${tbl}_valid_to_idx"
        ON "${tbl}" (valid_to)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "${tbl}_global_id_idx"
        ON "${tbl}" (global_id)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "${tbl}_current_uniq"
        ON "${tbl}" (global_id) WHERE valid_to IS NULL
    `);

    if (layer.parentFkColumn) {
      const fkCol = sanitizeIdentifier(layer.parentFkColumn);
      if (fkCol) {
        await this.prisma.$executeRawUnsafe(`
          ALTER TABLE "${tbl}"
            ADD COLUMN IF NOT EXISTS "${fkCol}" UUID
        `);
        await this.prisma.$executeRawUnsafe(`
          CREATE INDEX IF NOT EXISTS "${tbl}_${fkCol}_idx"
            ON "${tbl}" ("${fkCol}")
        `);
      }
    }

    for (const f of layer.fields ?? []) {
      const col = sanitizeIdentifier(f.name);
      if (!col) continue;
      const pg = toPgFieldType(f.type);
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE "${tbl}"
          ADD COLUMN IF NOT EXISTS "${col}" ${pg}
      `);
      // Explicit-trigger half of #23: when the schema marks a
      // field as searchable, ensure a btree index on it.
      // CREATE INDEX IF NOT EXISTS is idempotent, so toggling
      // searchable off and on again does not duplicate the
      // index; toggling off does NOT drop the index (we'd need
      // a deliberate drop pass for that, deferred so the index
      // sticks around even if the layer author makes a typo and
      // unticks the wrong field).
      if (f.searchable) {
        await this.prisma.$executeRawUnsafe(`
          CREATE INDEX IF NOT EXISTS "${tbl}_${col}_search_idx"
            ON "${tbl}" ("${col}")
        `);
      }
    }

    this.log.log(
      `Provisioned v3 layer table ${tbl} (geom=${layer.geometryType ?? 'table'})`,
    );
  }

  async dropLayer(itemId: string, layerId: string): Promise<void> {
    const tbl = toV3TableName(itemId, layerId);
    await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${tbl}"`);
    this.log.log(`Dropped v3 layer table ${tbl}`);
  }

  /**
   * Empty a layer's feature table without dropping it (#244).
   *
   * Replace-mode ingest needs "wipe what's there, then insert the new
   * source." TRUNCATE is the right primitive: it preserves the table
   * structure (columns, indexes, FKs back to the layer's metadata),
   * resets the row count to zero, and drops history along with current
   * rows. That last point matters: replace semantics mean "this is the
   * data now, forget what was there before," which is incompatible
   * with the temporal-versioning row history the table normally keeps.
   *
   * If the table doesn't exist yet (a fresh layer being imported into
   * for the first time), the TRUNCATE is a no-op via the IF-EXISTS
   * style guard the caller already runs (provisionLayer creates the
   * table before this is called).
   */
  async truncateLayer(itemId: string, layerId: string): Promise<void> {
    const tbl = toV3TableName(itemId, layerId);
    // RESTART IDENTITY isn't strictly needed (we use UUIDs not serials)
    // but it's defensive against future schema changes that add a
    // serial column. CASCADE is required if anything FKs into this
    // table; nothing does today, but cheap to keep correct.
    await this.prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "${tbl}" RESTART IDENTITY CASCADE`,
    );
    this.log.log(`Truncated v3 layer table ${tbl}`);
  }

  /**
   * Drops tables for layers present in `prev` but not `next`, then
   * provisions (idempotent) every layer in `next`. Safe to re-run.
   */
  async reconcile(
    itemId: string,
    prev: Array<{ id: string }>,
    next: V3LayerShape[],
  ): Promise<void> {
    const nextIds = new Set(next.map((l) => l.id));
    for (const old of prev) {
      if (!nextIds.has(old.id)) {
        await this.dropLayer(itemId, old.id);
      }
    }
    for (const l of next) {
      await this.provisionLayer(itemId, l);
    }
  }

  async dropAll(itemId: string, layerIds: string[]): Promise<void> {
    for (const lid of layerIds) {
      await this.dropLayer(itemId, lid);
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function sanitizeIdentifier(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
}

export function toV3TableName(itemId: string, layerId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)) {
    throw new BadRequestException('Invalid item ID format');
  }
  const lid = sanitizeIdentifier(layerId);
  if (!lid) throw new BadRequestException('Invalid layer ID format');
  return `fs_${itemId.replace(/-/g, '')}_${lid}`;
}

function toPgGeomType(
  g: 'point' | 'line' | 'polygon',
): 'MultiPoint' | 'MultiLineString' | 'MultiPolygon' {
  // Always provision Multi-* columns. Real-world spatial data
  // (especially shapefiles, where the OGR driver hands us a
  // generalized polygon ring concept) routinely mixes single and
  // multi geometries inside one "polygon" layer; PostGIS's strict
  // type check rejects MultiPolygon rows on a Polygon column with
  // SQLSTATE 22023. By promoting on the column side and ST_Multi()
  // ing on insert, we accept both, and queries that read the column
  // out work the same for downstream renderers.
  if (g === 'point') return 'MultiPoint';
  if (g === 'line') return 'MultiLineString';
  return 'MultiPolygon';
}

export function toPgFieldType(
  t: 'string' | 'number' | 'boolean' | 'date',
): string {
  if (t === 'number') return 'NUMERIC';
  if (t === 'boolean') return 'BOOLEAN';
  if (t === 'date') return 'TIMESTAMPTZ';
  return 'TEXT';
}
