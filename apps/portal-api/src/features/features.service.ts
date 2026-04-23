import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeatureRow {
  gid: bigint;
  global_id: string;
  geom: string | null; // GeoJSON geometry string
  properties: Record<string, unknown>;
  valid_from: Date;
  valid_to: Date | null;
  created_by: string;
  created_at: Date;
  edited_by: string;
  edited_at: Date;
}

export interface GeoJsonFeature {
  type: 'Feature';
  id: string; // global_id
  geometry: unknown;
  properties: Record<string, unknown>;
  _meta?: {
    gid: number;
    validFrom: string;
    createdBy: string;
    createdAt: string;
    editedBy: string;
    editedAt: string;
  };
}

export interface QueryFeaturesOpts {
  /** EPSG:4326 [minX, minY, maxX, maxY] */
  bbox?: [number, number, number, number];
  /** SQL-like where clause on properties — NOT passed to raw SQL; filtered in memory for v2 */
  limit?: number;
  offset?: number;
  /** ISO 8601 timestamp: return features valid at this moment */
  at?: string;
  includeMeta?: boolean;
}

export interface InsertFeatureInput {
  /** Client-generated GUID for offline sync; omit to let the server generate one. */
  globalId?: string | undefined;
  /** GeoJSON geometry object. Omit or pass undefined for geometry-less features. */
  geometry?: unknown;
  properties: Record<string, unknown>;
}

export interface UpdateFeatureInput {
  geometry?: unknown;
  properties?: Record<string, unknown>;
}

export interface TableStats {
  featureCount: number;
  bbox: [number, number, number, number] | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an item UUID to a safe PostgreSQL table name.
 * Only accepts properly-formatted UUIDs; throws for anything else so the
 * string can never be user-controlled SQL.
 */
function toTableName(itemId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)) {
    throw new BadRequestException('Invalid item ID format');
  }
  return `fs_${itemId.replace(/-/g, '')}`;
}

function rowToFeature(row: FeatureRow, includeMeta: boolean): GeoJsonFeature {
  let geometry: unknown = null;
  if (row.geom) {
    try {
      geometry = JSON.parse(row.geom);
    } catch {
      geometry = null;
    }
  }
  const f: GeoJsonFeature = {
    type: 'Feature',
    id: row.global_id,
    geometry,
    properties: row.properties,
  };
  if (includeMeta) {
    f._meta = {
      gid: Number(row.gid),
      validFrom: row.valid_from.toISOString(),
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
      editedBy: row.edited_by,
      editedAt: row.edited_at.toISOString(),
    };
  }
  return f;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Manages per-item PostGIS feature tables.
 *
 * Each feature_service item owns a dedicated table `fs_<uuid_no_dashes>`.
 * Rows are never overwritten — instead every update expires the old version
 * (sets valid_to = NOW()) and inserts a new one (valid_from = NOW(),
 * valid_to = NULL). Deletes likewise only set valid_to. This gives full
 * point-in-time query capability with no separate history table needed.
 *
 * Current state:   WHERE valid_to IS NULL
 * Point-in-time:   WHERE valid_from <= $t AND (valid_to IS NULL OR valid_to > $t)
 */
@Injectable()
export class FeaturesService {
  private readonly log = new Logger(FeaturesService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Table lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create the PostGIS table for a feature service item. Idempotent —
   * safe to call if the table already exists.
   */
  async provisionTable(itemId: string): Promise<void> {
    const tbl = toTableName(itemId);
    // Use raw template literal with $1 not possible for identifiers; we
    // validated the name above so interpolation is safe here.
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${tbl}" (
        gid         BIGSERIAL PRIMARY KEY,
        global_id   UUID        NOT NULL DEFAULT gen_random_uuid(),
        geom        GEOMETRY(Geometry, 4326),
        properties  JSONB       NOT NULL DEFAULT '{}',
        valid_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        valid_to    TIMESTAMPTZ,
        created_by  UUID        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        edited_by   UUID        NOT NULL,
        edited_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Spatial index for bbox queries.
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "${tbl}_geom_idx"
        ON "${tbl}" USING GIST (geom)
    `);
    // Index for point-in-time queries: filtering by valid_to IS NULL is
    // the hot path (current-state reads).
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "${tbl}_valid_to_idx"
        ON "${tbl}" (valid_to)
    `);
    // Index for stable feature identity lookups.
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "${tbl}_global_id_idx"
        ON "${tbl}" (global_id)
    `);
    this.log.log(`Provisioned feature table ${tbl}`);
  }

  /**
   * Drop the feature table for an item. Called when the item is purged.
   * Idempotent — safe if the table never existed.
   */
  async dropTable(itemId: string): Promise<void> {
    const tbl = toTableName(itemId);
    await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${tbl}"`);
    this.log.log(`Dropped feature table ${tbl}`);
  }

  /** True when the feature table exists (item has been upgraded to v2). */
  async tableExists(itemId: string): Promise<boolean> {
    const tbl = toTableName(itemId);
    const rows = await this.prisma.$queryRawUnsafe<[{ exists: boolean }]>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
      ) AS exists
    `, tbl);
    return rows[0]?.exists ?? false;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Bulk-insert features. Each feature gets a fresh global_id unless the
   * caller supplies one (offline-created features arrive with a client-side
   * GUID so parent/child relationships established offline survive sync).
   *
   * Returns the count of inserted rows.
   */
  async bulkInsert(
    itemId: string,
    features: InsertFeatureInput[],
    user: AuthUser,
  ): Promise<{ inserted: number }> {
    if (features.length === 0) return { inserted: 0 };
    const tbl = toTableName(itemId);
    const now = new Date();
    let inserted = 0;

    // Insert in batches of 500 to avoid very large SQL strings.
    const BATCH = 500;
    for (let i = 0; i < features.length; i += BATCH) {
      const batch = features.slice(i, i + BATCH);
      // Build a VALUES clause with numbered params.
      // Params per row: global_id, geom, properties, valid_from, created_by, edited_by
      // geom uses ST_SetSRID(ST_GeomFromGeoJSON($n), 4326)
      const params: unknown[] = [];
      const valueParts: string[] = [];

      for (const feat of batch) {
        const base = params.length + 1;
        // Push all 6 params unconditionally so $base through $base+5 are
        // always defined. COALESCE handles the null globalId case in SQL.
        params.push(
          feat.globalId ?? null,                                  // $base
          feat.geometry ? JSON.stringify(feat.geometry) : null,  // $base+1
          JSON.stringify(feat.properties ?? {}),                  // $base+2
          now.toISOString(),                                      // $base+3 valid_from
          user.id,                                                // $base+4 created_by
          user.id,                                                // $base+5 edited_by
        );
        // Always reference all 6 params so PostgreSQL's param count stays
        // consistent across rows. COALESCE / CASE WHEN handle null inputs.
        valueParts.push(`(
          COALESCE($${base}::uuid, gen_random_uuid()),
          CASE WHEN $${base + 1}::text IS NOT NULL
               THEN ST_SetSRID(ST_GeomFromGeoJSON($${base + 1}), 4326)
               ELSE NULL END,
          $${base + 2}::jsonb,
          $${base + 3}::timestamptz,
          $${base + 4}::uuid,
          $${base + 5}::uuid
        )`);
      }

      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "${tbl}"
           (global_id, geom, properties, valid_from, created_by, edited_by)
         VALUES ${valueParts.join(', ')}`,
        ...params,
      );
      inserted += batch.length;
    }

    return { inserted };
  }

  /**
   * Replace ALL current features (valid_to IS NULL) with a new set.
   * Expires existing rows then bulk-inserts the replacement set in a
   * single transaction.
   */
  async replaceAll(
    itemId: string,
    features: InsertFeatureInput[],
    user: AuthUser,
  ): Promise<{ inserted: number; expired: number }> {
    const tbl = toTableName(itemId);
    const now = new Date().toISOString();

    // Expire all current rows.
    const expireResult = await this.prisma.$executeRawUnsafe(
      `UPDATE "${tbl}"
          SET valid_to  = $1::timestamptz,
              edited_by = $2::uuid,
              edited_at = $1::timestamptz
        WHERE valid_to IS NULL`,
      now,
      user.id,
    );
    // $executeRawUnsafe returns the row count as a number.
    const expired = typeof expireResult === 'number' ? expireResult : 0;

    const { inserted } = await this.bulkInsert(itemId, features, user);
    return { inserted, expired };
  }

  /**
   * Update a single feature by its global_id: expire the current version
   * and insert a new one with the same global_id, preserving the original
   * created_by / created_at.
   */
  async updateFeature(
    itemId: string,
    globalId: string,
    patch: UpdateFeatureInput,
    user: AuthUser,
  ): Promise<GeoJsonFeature> {
    const tbl = toTableName(itemId);
    if (!/^[0-9a-f-]{36}$/i.test(globalId)) {
      throw new BadRequestException('Invalid feature id');
    }
    const now = new Date().toISOString();

    // Lock and fetch the current version.
    const current = await this.prisma.$queryRawUnsafe<FeatureRow[]>(
      `SELECT *,
              ST_AsGeoJSON(geom) AS geom
         FROM "${tbl}"
        WHERE global_id = $1::uuid AND valid_to IS NULL
        LIMIT 1`,
      globalId,
    );
    if (!current.length) throw new NotFoundException('Feature not found');
    const old = current[0];

    // Expire old version.
    await this.prisma.$executeRawUnsafe(
      `UPDATE "${tbl}"
          SET valid_to  = $1::timestamptz,
              edited_by = $2::uuid,
              edited_at = $1::timestamptz
        WHERE gid = $3`,
      now,
      user.id,
      old.gid,
    );

    const newGeom = patch.geometry !== undefined ? patch.geometry : (old.geom ? JSON.parse(old.geom) : null);
    const newProps = patch.properties !== undefined
      ? { ...(old.properties as Record<string, unknown>), ...patch.properties }
      : old.properties;

    // Always pass geom as $4 (null when absent); CASE handles both branches.
    const inserted = await this.prisma.$queryRawUnsafe<FeatureRow[]>(
      `INSERT INTO "${tbl}"
         (global_id, geom, properties, valid_from, created_by, created_at, edited_by, edited_at)
       VALUES (
         $1::uuid,
         CASE WHEN $4::text IS NOT NULL THEN ST_SetSRID(ST_GeomFromGeoJSON($4), 4326) ELSE NULL END,
         $5::jsonb,
         $2::timestamptz,
         $3::uuid,
         $6::timestamptz,
         $3::uuid,
         $2::timestamptz
       )
       RETURNING *, ST_AsGeoJSON(geom) AS geom`,
      globalId,
      now,
      user.id,
      newGeom ? JSON.stringify(newGeom) : null,
      JSON.stringify(newProps),
      old.created_at.toISOString(),
    );

    return rowToFeature(inserted[0], true);
  }

  /**
   * Soft-delete a feature by expiring its current version.
   */
  async deleteFeature(
    itemId: string,
    globalId: string,
    user: AuthUser,
  ): Promise<void> {
    const tbl = toTableName(itemId);
    if (!/^[0-9a-f-]{36}$/i.test(globalId)) {
      throw new BadRequestException('Invalid feature id');
    }
    const now = new Date().toISOString();
    const result = await this.prisma.$executeRawUnsafe(
      `UPDATE "${tbl}"
          SET valid_to  = $1::timestamptz,
              edited_by = $2::uuid,
              edited_at = $1::timestamptz
        WHERE global_id = $3::uuid AND valid_to IS NULL`,
      now,
      user.id,
      globalId,
    );
    if ((result as number) === 0) {
      throw new NotFoundException('Feature not found');
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Query features. Returns current-state by default; pass `opts.at` for
   * a point-in-time view. Optionally filter by bounding box.
   */
  async query(
    itemId: string,
    opts: QueryFeaturesOpts = {},
  ): Promise<GeoJsonFeature[]> {
    const tbl = toTableName(itemId);
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (opts.at) {
      const ts = new Date(opts.at);
      if (isNaN(ts.getTime())) throw new BadRequestException('Invalid at timestamp');
      params.push(ts.toISOString());
      const p = params.length;
      conditions.push(`valid_from <= $${p}::timestamptz AND (valid_to IS NULL OR valid_to > $${p}::timestamptz)`);
    } else {
      conditions.push('valid_to IS NULL');
    }

    if (opts.bbox) {
      const [minX, minY, maxX, maxY] = opts.bbox;
      params.push(minX, minY, maxX, maxY);
      const b = params.length;
      conditions.push(
        `geom IS NOT NULL AND ST_Intersects(geom, ST_MakeEnvelope($${b - 3}, $${b - 2}, $${b - 1}, $${b}, 4326))`,
      );
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ? `LIMIT ${Math.min(opts.limit, 10_000)}` : 'LIMIT 10000';
    const offset = opts.offset ? `OFFSET ${opts.offset}` : '';

    const rows = await this.prisma.$queryRawUnsafe<FeatureRow[]>(
      `SELECT *, ST_AsGeoJSON(geom) AS geom
         FROM "${tbl}"
        ${where}
        ORDER BY gid
        ${limit} ${offset}`,
      ...params,
    );

    return rows.map((r) => rowToFeature(r, opts.includeMeta ?? false));
  }

  /**
   * Fetch a single feature by global_id. Returns the current version
   * unless `at` is specified.
   */
  async getFeature(
    itemId: string,
    globalId: string,
    at?: string,
  ): Promise<GeoJsonFeature> {
    if (!/^[0-9a-f-]{36}$/i.test(globalId)) {
      throw new BadRequestException('Invalid feature id');
    }
    const tbl = toTableName(itemId);
    const params: unknown[] = [globalId];
    let temporalClause: string;

    if (at) {
      const ts = new Date(at);
      if (isNaN(ts.getTime())) throw new BadRequestException('Invalid at timestamp');
      params.push(ts.toISOString());
      temporalClause = `AND valid_from <= $2::timestamptz AND (valid_to IS NULL OR valid_to > $2::timestamptz)`;
    } else {
      temporalClause = 'AND valid_to IS NULL';
    }

    const rows = await this.prisma.$queryRawUnsafe<FeatureRow[]>(
      `SELECT *, ST_AsGeoJSON(geom) AS geom
         FROM "${tbl}"
        WHERE global_id = $1::uuid ${temporalClause}
        LIMIT 1`,
      ...params,
    );
    if (!rows.length) throw new NotFoundException('Feature not found');
    return rowToFeature(rows[0], true);
  }

  /**
   * Retrieve version history for a feature (all versions, newest first).
   */
  async getHistory(itemId: string, globalId: string): Promise<GeoJsonFeature[]> {
    if (!/^[0-9a-f-]{36}$/i.test(globalId)) {
      throw new BadRequestException('Invalid feature id');
    }
    const tbl = toTableName(itemId);
    const rows = await this.prisma.$queryRawUnsafe<FeatureRow[]>(
      `SELECT *, ST_AsGeoJSON(geom) AS geom
         FROM "${tbl}"
        WHERE global_id = $1::uuid
        ORDER BY valid_from DESC`,
      globalId,
    );
    return rows.map((r) => rowToFeature(r, true));
  }

  /**
   * Compute feature count and bounding box for the item metadata.
   * Returns null bbox when there are no features or all geometries are null.
   */
  async stats(itemId: string): Promise<TableStats> {
    const tbl = toTableName(itemId);
    const rows = await this.prisma.$queryRawUnsafe<
      [{ cnt: bigint; minx: number | null; miny: number | null; maxx: number | null; maxy: number | null }]
    >(
      `SELECT
         COUNT(*)                            AS cnt,
         ST_XMin(ST_Extent(geom))::float8   AS minx,
         ST_YMin(ST_Extent(geom))::float8   AS miny,
         ST_XMax(ST_Extent(geom))::float8   AS maxx,
         ST_YMax(ST_Extent(geom))::float8   AS maxy
         FROM "${tbl}"
        WHERE valid_to IS NULL`,
    );
    const r = rows[0];
    const featureCount = Number(r?.cnt ?? 0);
    const bbox: [number, number, number, number] | null =
      r?.minx != null && r?.miny != null && r?.maxx != null && r?.maxy != null
        ? [r.minx, r.miny, r.maxx, r.maxy]
        : null;
    return { featureCount, bbox };
  }

  /**
   * Return the full current-state GeoJSON FeatureCollection suitable for
   * direct consumption by MapLibre. Streams all current features.
   */
  async toGeoJsonCollection(
    itemId: string,
    opts: Pick<QueryFeaturesOpts, 'bbox' | 'at'> = {},
  ): Promise<{ type: 'FeatureCollection'; features: GeoJsonFeature[] }> {
    const features = await this.query(itemId, { ...opts, limit: 10_000 });
    return { type: 'FeatureCollection', features };
  }
}
