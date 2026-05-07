// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { DerivedLayerCacheRefreshService } from '../derived-layers/cache-refresh.service.js';
import {
  sanitizeIdentifier,
  toPgFieldType,
  toV3TableName,
} from './v3-tables.service.js';

/**
 * Per-layer feature CRUD for v3 data_layer items.
 *
 * Lifecycle (create/alter/drop tables) lives in V3TablesService; this
 * service only handles row-level operations against already-provisioned
 * tables. ItemsService's get() / sharing checks should be applied by
 * the controller before reaching here.
 */

export interface V3FeatureInsert {
  globalId?: string;
  geometry?: unknown;
  properties?: Record<string, unknown> | undefined;
}

export interface V3FeatureOut {
  type: 'Feature';
  id: string;
  geometry: unknown;
  properties: Record<string, unknown>;
}

interface V3Row {
  gid: bigint;
  global_id: string;
  /**
   * Optional. Spatial layers select `ST_AsGeoJSON(geom) AS geom`;
   * table sublayers (geometryType=null at provision time) skip the
   * column entirely (#192) and the row mapper emits geometry:null.
   */
  geom?: string | null;
  properties: Record<string, unknown>;
  valid_from: Date;
  valid_to: Date | null;
  created_by: string;
  created_at: Date;
  edited_by: string;
  edited_at: Date;
}

@Injectable()
export class V3FeaturesService {
  private readonly log = new Logger(V3FeaturesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheRefresh: DerivedLayerCacheRefreshService,
  ) {}

  /** Current-state feature collection for a layer. Supports bbox
   *  filter + point-in-time (?at=) in the usual temporal-table form,
   *  plus an optional `geoLimit` GeoJSON geometry that intersects
   *  every returned row (used to enforce per-share geographic
   *  restrictions). */
  async listFeatures(
    itemId: string,
    layerId: string,
    opts: {
      bbox?: [number, number, number, number];
      at?: string;
      geoLimit?: unknown;
      /**
       * Layer-level boundary clip (#34). GeoJSON geometry that
       * narrows the SELECT to features intersecting the polygon.
       * Distinct from `geoLimit` (which is per-share access scope):
       * this is the map author's "show only features in this region
       * for this layer" content scope. ANDs with geoLimit when both
       * are present. Unlike geoLimit, null-geom features are NOT
       * leaked through this clip -- a layer-content clip applies
       * to spatial features only, and an attribute-only row in a
       * layer that has a boundary clip set is ambiguous; we err on
       * the side of less data rather than more.
       */
      boundaryClip?: unknown;
      /**
       * When set, the SELECT is narrowed to features the named user
       * created (`created_by = userId`). Pairs with the share-level
       * rowScope='own' (#40) and the layer-level editingPolicy
       * 'own-rows-only' (#41). Owner / admin / org-public callers
       * never reach this path; the controller bypasses scoping for
       * them at assertV3Layer time.
       */
      ownRowsOnly?: { userId: string };
      /**
       * Set when the target layer was provisioned without a `geom`
       * column (geometryType=null, the related-event-tracking
       * pattern from #174). Skips the geom projection AND every
       * spatial filter so the SELECT doesn't reference a column
       * that doesn't exist (#192). The controller derives this
       * from the layer's geometryType in assertV3Layer.
       */
      isTable?: boolean;
      /**
       * #247: narrows the SELECT to rows whose `properties->>{column}`
       * equals `parentId`. Used by the field-runtime FormModal to
       * list every related child of a given parent feature without
       * scanning every row in the layer. Column name is validated by
       * the controller against the layer's schema before reaching
       * here so it's safe to interpolate; values are still
       * parameterized.
       */
      parentFkFilter?: { column: string; parentId: string };
    } = {},
  ): Promise<{ type: 'FeatureCollection'; features: V3FeatureOut[] }> {
    const tbl = toV3TableName(itemId, layerId);
    const whereClauses: string[] = [];
    const params: unknown[] = [];
    if (opts.at) {
      params.push(opts.at);
      whereClauses.push(
        `valid_from <= $${params.length} AND (valid_to IS NULL OR valid_to > $${params.length})`,
      );
    } else {
      whereClauses.push(`valid_to IS NULL`);
    }
    // Spatial filters only run when the layer actually has a geom
    // column to filter on. Table sublayers ignore bbox / geoLimit /
    // boundaryClip silently: they're attribute-only rows and access
    // is governed by the parent layer's share, not by geometry.
    if (!opts.isTable) {
      if (opts.bbox) {
        params.push(opts.bbox[0], opts.bbox[1], opts.bbox[2], opts.bbox[3]);
        const n = params.length;
        whereClauses.push(
          `geom && ST_MakeEnvelope($${n - 3}, $${n - 2}, $${n - 1}, $${n}, 4326)`,
        );
      }
      if (opts.geoLimit) {
        // Rows either intersect the allowed polygon, or have no geometry
        // at all (attribute-only rows in a mixed-shape spatial table
        // leak through here and are filtered by the controller's parent
        // layer inheritance for related tables). ST_GeomFromGeoJSON
        // handles Polygon, MultiPolygon, and GeometryCollection in the
        // same call.
        params.push(JSON.stringify(opts.geoLimit));
        const n = params.length;
        whereClauses.push(
          `(geom IS NULL OR ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON($${n}), 4326)))`,
        );
      }
      if (opts.boundaryClip) {
        // Layer-content clip (#34). Strictly requires a geometry that
        // intersects -- attribute-only rows are excluded so the map
        // author's "render only features in this region" intent is
        // honored even for tables with mixed spatial/non-spatial rows.
        params.push(JSON.stringify(opts.boundaryClip));
        const n = params.length;
        whereClauses.push(
          `geom IS NOT NULL AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON($${n}), 4326))`,
        );
      }
    }
    if (opts.ownRowsOnly) {
      // Row-scope filter (#40). Only features the caller created
      // pass through. Indexed on created_by since #23 reconciles a
      // btree on the column when the layer is provisioned.
      params.push(opts.ownRowsOnly.userId);
      const n = params.length;
      whereClauses.push(`created_by = $${n}`);
    }
    if (opts.parentFkFilter) {
      // #247: parent-FK filter. Column name is validated against the
      // layer schema in the controller (must match a real field) so
      // the `properties->>'col'` form is safe; only the parentId
      // value is parameterized. Avoid quoting the column name with
      // double quotes -- properties is a JSONB blob, not a column,
      // and the key inside it is whatever the schema says it is
      // (single-quoted SQL string literal). The controller
      // pre-quotes the column with the same regex used by other
      // schema-derived identifiers.
      params.push(opts.parentFkFilter.parentId);
      const n = params.length;
      whereClauses.push(
        `properties->>'${opts.parentFkFilter.column}' = $${n}`,
      );
    }
    // Build the projection. Table layers have no geom column so we
    // omit the cast entirely; rowToFeature falls back to geometry:null
    // when row.geom is undefined.
    const geomProjection = opts.isTable ? '' : 'ST_AsGeoJSON(geom) AS geom,';
    // Hard cap on the result set. With 800k+ polygon layers, an
    // unbounded SELECT here returned a row buffer too large for
    // Prisma's napi bridge: the rust->js String conversion blew up
    // with "Failed to convert rust `String` into napi `string`",
    // which surfaced to the user as a 500 in the detail-page
    // Browse panel and the map attribute table. The cap keeps
    // those surfaces functional for big layers (preview shape)
    // without changing behaviour for typical-sized layers.
    //
    // The map render path passes `?bbox=` and hits the GIST index
    // on `geom`, so it never returns more than the rows that
    // actually intersect the viewport (typical city-zoom result
    // is dozens to low thousands, well under the cap). This is
    // the same pattern Esri's hosted feature services use:
    // spatial index + bbox-clipped reads, no precomputed tiles.
    // If we hit a viewport that's both unusually dense AND not
    // narrow enough to be under the cap, server-side
    // simplification (ST_SimplifyPreserveTopology) keyed off the
    // requested zoom is the next lever -- still no MVT required
    // for normal interactive use.
    // #270: bumped from 10000 to 100000 because the 10k limit was
    // silently truncating offline-area downloads -- the field PWA
    // builder hits this same endpoint and a worker downloading a
    // city/county-scale parcel layer ended up with a non-deterministic
    // 10k subset of rows with no UI signal that anything was missing.
    // Modern devices have plenty of storage; the byte-budget concern
    // (napi-string overflow at ~800k rows) is still ~8x away.
    // Pagination via offset+limit is the proper fix when we need to
    // exceed 100k; this value is the working ceiling for now.
    const HARD_CAP = 100000;
    const sql = `
      SELECT gid, global_id, ${geomProjection} properties,
             valid_from, valid_to, created_by, created_at, edited_by, edited_at
      FROM "${tbl}"
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY gid
      LIMIT ${HARD_CAP}
    `;
    const rows = await this.prisma.$queryRawUnsafe<V3Row[]>(sql, ...params);
    return {
      type: 'FeatureCollection',
      features: rows.map(rowToFeature),
    };
  }

  /** Bulk-insert features. Accepts optional client-generated globalId
   *  so offline-authored features keep their identity post-sync. Also
   *  spreads matching property keys into typed columns whose names
   *  appear in the layer's field list (#294): keeps `properties` as
   *  the JSONB source of truth AND populates the typed columns the
   *  layer schema declares, so attribute-table queries / SQL JOINs /
   *  ORDER BYs work without parsing JSONB. The spread is purely
   *  additive: properties without matching columns are ignored
   *  (covered by JSONB), columns without a matching property write
   *  NULL. */
  async insertFeatures(
    itemId: string,
    layerId: string,
    inputs: V3FeatureInsert[],
    user: AuthUser,
    opts: { isTable?: boolean } = {},
  ): Promise<{ inserted: number }> {
    if (inputs.length === 0) return { inserted: 0 };
    const tbl = toV3TableName(itemId, layerId);
    const now = new Date();
    let inserted = 0;
    // Look up the layer's typed fields once. These are the columns
    // whose names match the keys in the row's properties; we add a
    // parameterised value per row per field. Wrong-named or missing
    // properties just get NULL in their column.
    const typedFields = await this.getTypedFields(itemId, layerId);
    const typedCols = typedFields
      .map((f) => `"${f.sqlName}"`)
      .join(typedFields.length > 0 ? ', ' : '');
    // Coerce a property value into the shape the column's PG type
    // expects. JSONB stores numbers / booleans natively, but Postgres
    // typed-column casts care about JS string vs number vs boolean
    // input; this normalises the incoming value before it becomes a
    // bound parameter.
    const coerce = (val: unknown, type: 'string' | 'number' | 'boolean' | 'date'): unknown => {
      if (val === undefined || val === null || val === '') return null;
      if (type === 'number') {
        const n = typeof val === 'number' ? val : Number(val);
        return Number.isFinite(n) ? n : null;
      }
      if (type === 'boolean') {
        if (typeof val === 'boolean') return val;
        if (val === 'true' || val === 1 || val === '1') return true;
        if (val === 'false' || val === 0 || val === '0') return false;
        return null;
      }
      if (type === 'date') {
        // Accept Date, ISO string, or numeric epoch. Render to ISO so
        // the timestamptz cast is unambiguous.
        if (val instanceof Date) return val.toISOString();
        if (typeof val === 'number') return new Date(val).toISOString();
        if (typeof val === 'string') return val;
        return null;
      }
      // string: comma-join arrays of primitives (the Survey123 /
      // ArcGIS convention for select-many, ranking, image-choice
      // multi values, etc., #295). Choice codes are expected to
      // not contain commas; if they do the value's still legible
      // but the comma boundary becomes ambiguous. Object arrays
      // (and bare objects) fall back to JSON.stringify so legacy
      // attachment shapes that haven't moved to #292's child
      // table yet survive the column cast.
      if (typeof val === 'string') return val;
      if (Array.isArray(val)) {
        const allPrimitive = val.every(
          (item) =>
            item === null ||
            typeof item === 'string' ||
            typeof item === 'number' ||
            typeof item === 'boolean',
        );
        if (allPrimitive) {
          return val
            .filter((item) => item !== null && item !== undefined)
            .map((item) => String(item))
            .join(',');
        }
      }
      return JSON.stringify(val);
    };
    // Batch multi-row VALUES inserts. The previous code did one
    // $executeRawUnsafe per feature, which on a county-scale shapefile
    // (869k features) means 869k roundtrips and pushes a single import
    // past the BFF timeout. 500 rows/batch keeps the param count well
    // under PostgreSQL's per-statement cap (~32k):
    //   table:   (4 + typedFields) params/row * 500
    //   geom:    (5 + typedFields) params/row * 500
    // Even with 50 typed fields, 500 rows * 55 = 27,500: under the cap.
    const BATCH = 500;
    // #349: explicit per-column casts for the typed-field tail.
    // Earlier note ("PG infers the type from the column on INSERT")
    // turned out to be wishful thinking: when coerce() returns a
    // JS string for a date/number/boolean field, node-postgres
    // binds it as TEXT and PG refuses the implicit cast to
    // timestamptz / numeric / boolean (SQLSTATE 42804). The form
    // mirror's #329 typed-bookkeeping path landed the failure
    // first because submitted_at was suddenly a typed timestamptz
    // column being fed an ISO string. Add the cast inline at the
    // placeholder so PG knows what to do with the bound text.
    const typedCastFor = (
      type: 'string' | 'number' | 'boolean' | 'date',
    ): string => {
      switch (type) {
        case 'date':
          return '::timestamptz';
        case 'number':
          return '::numeric';
        case 'boolean':
          return '::boolean';
        case 'string':
          return ''; // text default; no cast needed
      }
    };
    if (opts.isTable) {
      // Table sublayers (no geom column) get a different INSERT shape:
      // dropping the geom column from the column list AND its parameter
      // so we don't reference a column that doesn't exist (#192). Any
      // f.geometry is silently ignored on a table layer.
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const params: unknown[] = [];
        const valueRows: string[] = [];
        for (const f of batch) {
          const base = params.length + 1;
          params.push(
            f.globalId ?? null,
            JSON.stringify(f.properties ?? {}),
            now,
            user.id,
          );
          // Append a coerced value per typed field.
          for (const tf of typedFields) {
            params.push(coerce(f.properties?.[tf.name], tf.type));
          }
          const typedPlaceholders = typedFields
            .map((tf, ti) => `$${base + 4 + ti}${typedCastFor(tf.type)}`)
            .join(typedFields.length > 0 ? ', ' : '');
          valueRows.push(
            `(COALESCE($${base}::uuid, gen_random_uuid()), ` +
              `$${base + 1}::jsonb, $${base + 2}::timestamptz, ` +
              `$${base + 3}::uuid, $${base + 3}::uuid` +
              (typedPlaceholders ? `, ${typedPlaceholders}` : '') +
              `)`,
          );
        }
        const colList =
          `(global_id, properties, valid_from, created_by, edited_by` +
          (typedCols ? `, ${typedCols}` : '') +
          `)`;
        await this.prisma.$executeRawUnsafe(
          `INSERT INTO "${tbl}" ${colList} VALUES ${valueRows.join(', ')}`,
          ...params,
        );
        inserted += batch.length;
      }
    } else {
      for (let i = 0; i < inputs.length; i += BATCH) {
        const batch = inputs.slice(i, i + BATCH);
        const params: unknown[] = [];
        const valueRows: string[] = [];
        for (const f of batch) {
          const base = params.length + 1;
          params.push(
            f.globalId ?? null,
            f.geometry ? JSON.stringify(f.geometry) : null,
            JSON.stringify(f.properties ?? {}),
            now,
            user.id,
          );
          for (const tf of typedFields) {
            params.push(coerce(f.properties?.[tf.name], tf.type));
          }
          const typedPlaceholders = typedFields
            .map((tf, ti) => `$${base + 5 + ti}${typedCastFor(tf.type)}`)
            .join(typedFields.length > 0 ? ', ' : '');
          valueRows.push(
            `(COALESCE($${base}::uuid, gen_random_uuid()), ` +
              `CASE WHEN $${base + 1}::text IS NULL THEN NULL ` +
              `ELSE ST_Multi(ST_GeomFromGeoJSON($${base + 1})) END, ` +
              `$${base + 2}::jsonb, $${base + 3}::timestamptz, ` +
              `$${base + 4}::uuid, $${base + 4}::uuid` +
              (typedPlaceholders ? `, ${typedPlaceholders}` : '') +
              `)`,
          );
        }
        const colList =
          `(global_id, geom, properties, valid_from, created_by, edited_by` +
          (typedCols ? `, ${typedCols}` : '') +
          `)`;
        await this.prisma.$executeRawUnsafe(
          `INSERT INTO "${tbl}" ${colList} VALUES ${valueRows.join(', ')}`,
          ...params,
        );
        inserted += batch.length;
      }
    }
    this.log.log(`Inserted ${inserted} features into ${tbl}`);
    // Lazy-grow buffer-by-field caches on any derived layer that
    // reads from this source. Best-effort: notifySourceWrite swallows
    // its own errors so an insert that goes through here is never
    // rolled back by a downstream cache problem.
    void this.cacheRefresh.notifySourceWrite(
      itemId,
      layerId,
      inputs.map((f) => f.properties),
    );
    return { inserted };
  }

  /**
   * Look up the typed fields declared on a v3 layer's sublayer (#294).
   * Returns one entry per field with the JS-side property name (used
   * to read out of the input row's properties), the sanitized SQL
   * column name (used in the INSERT), and the FeatureField type the
   * value should be coerced to. Tolerates legacy item shapes that
   * stored fields under data.fields (v1/v2) or data.layers[].fields
   * (v3); on missing / malformed shapes returns an empty list and the
   * spread becomes a no-op.
   */
  private async getTypedFields(
    itemId: string,
    layerId: string,
  ): Promise<Array<{
    name: string;
    sqlName: string;
    type: 'string' | 'number' | 'boolean' | 'date';
  }>> {
    const item = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { data: true },
    });
    if (!item) return [];
    const data = (item.data ?? {}) as {
      version?: number;
      layers?: Array<{ id?: string; key?: string; fields?: unknown[] }>;
      fields?: unknown[];
    };
    let raw: unknown[] | undefined;
    if (Array.isArray(data.layers)) {
      const sub = data.layers.find(
        (l) => l.id === layerId || l.key === layerId,
      );
      raw = sub?.fields;
    } else {
      raw = data.fields;
    }
    if (!Array.isArray(raw)) return [];
    const out: Array<{
      name: string;
      sqlName: string;
      type: 'string' | 'number' | 'boolean' | 'date';
    }> = [];
    for (const f of raw) {
      if (!f || typeof f !== 'object') continue;
      const ff = f as { name?: unknown; type?: unknown };
      if (typeof ff.name !== 'string' || ff.name.length === 0) continue;
      const sqlName = sanitizeIdentifier(ff.name);
      if (!sqlName) continue;
      // Only include declared FeatureFieldType values; the column
      // provisioner skips anything else, so we shouldn't try to
      // populate them either.
      let type: 'string' | 'number' | 'boolean' | 'date';
      switch (ff.type) {
        case 'number':
        case 'boolean':
        case 'date':
          type = ff.type;
          break;
        case 'string':
        case undefined:
          type = 'string';
          break;
        default:
          continue;
      }
      // Validate that toPgFieldType doesn't disagree with our
      // mapping. Defensive guard: if someone evolves field type
      // semantics, the mismatch shows up at runtime instead of
      // silently NULLing the column.
      if (!toPgFieldType(type)) continue;
      out.push({ name: ff.name, sqlName, type });
    }
    return out;
  }

  /** Update a feature by expiring the current row and inserting a new
   *  one: same temporal-versioning pattern as the v2 features service. */
  async updateFeature(
    itemId: string,
    layerId: string,
    featureId: string,
    patch: { geometry?: unknown; properties?: Record<string, unknown> },
    user: AuthUser,
    opts: { ownRowsOnly?: boolean; isTable?: boolean } = {},
  ): Promise<V3FeatureOut> {
    const tbl = toV3TableName(itemId, layerId);
    // Table layers (#192): no geom column means the SELECT, the
    // current-row carry-forward, and the INSERT all need to skip
    // anything that touches geom. Patches that include a geometry
    // are silently dropped on a table layer.
    const isTable = opts.isTable === true;
    // Capture the merged props inside the transaction so we can fire
    // the cache-refresh hook AFTER the tx commits. Firing inside the
    // transaction (even with `void`) means the cache work runs in
    // parallel to commit, which can read a pre-commit view of the
    // source on its own connection. Out here we know the write is
    // durable.
    let mergedProps: Record<string, unknown> | null = null;
    let cacheLayerKey: string | null = null;
    const out = await this.prisma.$transaction(async (tx) => {
      const selectGeom = isTable ? '' : 'ST_AsGeoJSON(geom) AS geom,';
      const cur = await tx.$queryRawUnsafe<V3Row[]>(
        `
        SELECT gid, global_id, ${selectGeom} properties,
               valid_from, valid_to, created_by, created_at, edited_by, edited_at
        FROM "${tbl}"
        WHERE global_id = $1::uuid AND valid_to IS NULL
        FOR UPDATE
        `,
        featureId,
      );
      if (!cur.length) throw new NotFoundException('Feature not found');
      // Row-scope guard (#40). When the caller is restricted to
      // their own rows, refuse the edit if this feature was created
      // by anyone else. Surface as NotFound rather than Forbidden so
      // we don't leak the row's existence; that matches the pattern
      // the rest of the API uses for items the caller cannot see.
      if (opts.ownRowsOnly && cur[0]!.created_by !== user.id) {
        throw new NotFoundException('Feature not found');
      }
      const now = new Date();
      await tx.$executeRawUnsafe(
        `UPDATE "${tbl}" SET valid_to = $1, edited_by = $2::uuid, edited_at = $1 WHERE gid = $3`,
        now,
        user.id,
        cur[0]!.gid,
      );
      const nextProps =
        patch.properties !== undefined ? patch.properties : cur[0]!.properties;
      if (isTable) {
        // No geom column: smaller INSERT / RETURNING, no geometry
        // carry-forward (cur[0].geom is undefined for table layers).
        const inserted = await tx.$queryRawUnsafe<V3Row[]>(
          `
          INSERT INTO "${tbl}"
            (global_id, properties, valid_from, created_by, created_at, edited_by, edited_at)
          VALUES
            ($1::uuid, $2::jsonb, $3, $4::uuid, $5, $4::uuid, $3)
          RETURNING gid, global_id, properties,
                    valid_from, valid_to, created_by, created_at, edited_by, edited_at
          `,
          featureId,
          JSON.stringify(nextProps),
          now,
          user.id,
          cur[0]!.created_at,
        );
        // Table layers have no geometry, so they can't be the source
        // of a buffer derived layer; skip the cache notification.
        return rowToFeature(inserted[0]!);
      }
      const nextGeometry =
        patch.geometry !== undefined
          ? patch.geometry
          : cur[0]!.geom
            ? JSON.parse(cur[0]!.geom)
            : null;
      const inserted = await tx.$queryRawUnsafe<V3Row[]>(
        `
        INSERT INTO "${tbl}"
          (global_id, geom, properties, valid_from, created_by, created_at, edited_by, edited_at)
        VALUES
          ($1::uuid, CASE WHEN $2::text IS NULL THEN NULL ELSE ST_Multi(ST_GeomFromGeoJSON($2)) END,
           $3::jsonb, $4, $5::uuid, $6, $5::uuid, $4)
        RETURNING gid, global_id, ST_AsGeoJSON(geom) AS geom, properties,
                  valid_from, valid_to, created_by, created_at, edited_by, edited_at
        `,
        featureId,
        nextGeometry ? JSON.stringify(nextGeometry) : null,
        JSON.stringify(nextProps),
        now,
        user.id,
        cur[0]!.created_at,
      );
      mergedProps = nextProps as Record<string, unknown>;
      cacheLayerKey = layerId;
      return rowToFeature(inserted[0]!);
    });
    // Lazy-grow buffer-by-field caches on dependents now that the
    // transaction has committed. notifySourceWrite swallows its own
    // errors so a cache problem can't bring down a successful edit.
    if (mergedProps !== null) {
      void this.cacheRefresh.notifySourceWrite(itemId, cacheLayerKey, [
        mergedProps,
      ]);
    }
    return out;
  }

  /** Expire (soft-delete) a feature. */
  async deleteFeature(
    itemId: string,
    layerId: string,
    featureId: string,
    user: AuthUser,
    opts: { ownRowsOnly?: boolean } = {},
  ): Promise<void> {
    const tbl = toV3TableName(itemId, layerId);
    const now = new Date();
    // Row-scope guard (#40). The UPDATE narrows by created_by when
    // the caller is restricted to their own rows; if zero rows are
    // affected we surface NotFound just like a missing feature.
    const ownClause = opts.ownRowsOnly ? ' AND created_by = $4::uuid' : '';
    const ownParams = opts.ownRowsOnly ? [user.id] : [];
    const affected = await this.prisma.$executeRawUnsafe(
      `
      UPDATE "${tbl}"
         SET valid_to = $1, edited_by = $2::uuid, edited_at = $1
       WHERE global_id = $3::uuid AND valid_to IS NULL${ownClause}
      `,
      now,
      user.id,
      featureId,
      ...ownParams,
    );
    if (affected === 0) throw new NotFoundException('Feature not found');
  }
}

function rowToFeature(row: V3Row): V3FeatureOut {
  let geometry: unknown = null;
  if (row.geom) {
    try {
      geometry = JSON.parse(row.geom);
    } catch {
      geometry = null;
    }
  }
  // Inline editor-tracking columns as underscore-prefixed properties
  // so popups, attribute tables, and v3 feature browsers all surface
  // them without a second round-trip. Underscore prefix marks them as
  // system metadata; the popup 'all' renderer skips underscore keys
  // by default and the dedicated metadata footer formats them
  // explicitly. See task #39.
  return {
    type: 'Feature',
    id: row.global_id,
    geometry,
    properties: {
      ...row.properties,
      // _global_id duplicates the top-level Feature.id so callers can
      // recover it after MapLibre's generateId rewrites the id slot
      // (the map renderer sets generateId: true on the source so its
      // selection machinery has a stable integer id; v3 PATCH/DELETE
      // need the original UUID, which we read out of properties from
      // queryRenderedFeatures). Same underscore-prefix convention as
      // editor tracking; popup 'all' mode skips underscore keys.
      _global_id: row.global_id,
      _created_by: row.created_by,
      _created_at: row.created_at?.toISOString?.() ?? row.created_at,
      _edited_by: row.edited_by,
      _edited_at: row.edited_at?.toISOString?.() ?? row.edited_at,
    },
  };
}
