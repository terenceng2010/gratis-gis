// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EngineService is the portal-api integration layer for the
// observation-log engine. It accepts engine `Observation` values, fills
// in the bookkeeping fields (`id`, `txTime`, `cell`), validates them,
// inserts them as rows in the `observation` table, and reads them back
// as GeoJSON features.
//
// Phase 1: no policy enforcement (everything is permitted), no
// materialized views, no streaming. Reads always hit the live log.
// Policy + lens runtime + MV cache land in Phase 2 and beyond.
//
// SQL is hand-written via Prisma's `$queryRaw` / `$executeRaw` because
// the `observation` table is intentionally not modeled in
// `schema.prisma` (Prisma cannot express PARTITION BY, UUIDv7 ids
// from app code, or the spatial / GIN indexes we rely on).

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  type GeoJsonGeometry,
  type Observation,
  type ObservationKind,
  type ReadFeature,
  type ReadQuery,
  cellForGeometry,
  uuidv7,
  validateObservation,
} from '@gratis-gis/engine';

import { PrismaService } from '../prisma/prisma.service.js';

interface ObservationRow {
  id: string;
  tx_time: Date;
  valid_from: Date;
  valid_to: Date | null;
  scope: string;
  entity: string;
  kind: ObservationKind;
  attrs: Record<string, unknown> | null;
  geom_geojson: GeoJsonGeometry | null;
  cell: string | null;
  author_sub: string;
  source: { kind: string; details?: Record<string, unknown> };
  parents: string[];
}

@Injectable()
export class EngineService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write an observation to the log. Fills in `id` (UUIDv7), `txTime`
   * (now), and `cell` (H3 res 7) when omitted. Validates the result
   * and throws on malformed input. Returns the persisted observation
   * with all bookkeeping fields populated.
   */
  async write(input: Observation): Promise<Observation> {
    const obs: Observation = {
      ...input,
      id: input.id ?? uuidv7(),
      txTime: input.txTime ?? new Date(),
      cell: input.cell ?? cellForGeometry(input.geom),
    };
    validateObservation(obs);

    const geomJson = obs.geom !== null ? JSON.stringify(obs.geom) : null;
    const attrsJson = obs.attrs !== null ? JSON.stringify(obs.attrs) : null;
    const sourceJson = JSON.stringify(obs.source);

    await this.prisma.$executeRaw`
      INSERT INTO observation (
        id, tx_time, valid_from, valid_to, scope, entity, kind,
        attrs, geom, cell, author_sub, source, parents
      ) VALUES (
        ${obs.id}::uuid,
        ${obs.txTime}::timestamptz,
        ${obs.validFrom}::timestamptz,
        ${obs.validTo}::timestamptz,
        ${obs.scope},
        ${obs.entity}::uuid,
        ${obs.kind},
        ${attrsJson}::jsonb,
        ${
          geomJson === null
            ? Prisma.sql`NULL`
            : Prisma.sql`ST_GeomFromGeoJSON(${geomJson}::text)`
        },
        ${obs.cell ?? null},
        ${obs.author.sub},
        ${sourceJson}::jsonb,
        ${obs.parents}::uuid[]
      )
    `;

    return obs;
  }

  /**
   * Read the current truth (or the truth at `asOf`) for entities in
   * a scope. Returns one GeoJSON feature per entity. Tombstones
   * (`kind = 'delete'`) are filtered out so deleted entities do not
   * appear in the result.
   *
   * Phase 1 is intentionally minimal: no attribute filters, no
   * geometry filters. Those land with the lens runtime in Phase 3.
   */
  async read(query: ReadQuery): Promise<ReadFeature[]> {
    const asOf = query.asOf ?? new Date();
    const limit = query.limit ?? 1000;

    const entityFilter =
      query.entity !== undefined
        ? Prisma.sql`AND entity = ${query.entity}::uuid`
        : Prisma.empty;

    const rows = await this.prisma.$queryRaw<ObservationRow[]>`
      WITH currents AS (
        SELECT DISTINCT ON (entity)
          id,
          tx_time,
          valid_from,
          valid_to,
          scope,
          entity,
          kind,
          attrs,
          ST_AsGeoJSON(geom)::jsonb AS geom_geojson,
          cell,
          author_sub,
          source,
          parents
        FROM observation
        WHERE scope = ${query.scope}
          AND valid_from <= ${asOf}::timestamptz
          ${entityFilter}
        ORDER BY entity, valid_from DESC, tx_time DESC
      )
      SELECT *
      FROM currents
      WHERE kind <> 'delete'
      LIMIT ${limit}
    `;

    return rows.map(rowToFeature);
  }
}

function rowToFeature(row: ObservationRow): ReadFeature {
  return {
    type: 'Feature',
    id: row.entity,
    geometry: row.geom_geojson,
    properties: {
      ...(row.attrs ?? {}),
      __engine: {
        observationId: row.id,
        validFrom: row.valid_from.toISOString(),
        validTo: row.valid_to !== null ? row.valid_to.toISOString() : null,
        txTime: row.tx_time.toISOString(),
        kind: row.kind,
        authorSub: row.author_sub,
      },
    },
  };
}
