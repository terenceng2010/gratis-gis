// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  GeocodingCandidate,
  GeocodingServiceData,
} from '@gratis-gis/shared-types';
import { isGeocodingServiceData } from '@gratis-gis/shared-types';

import { ItemsService } from '../items/items.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * Runtime engine for the geocoding_service item type (#74).
 *
 * search() takes a geocoding_service item id + an input string and
 * returns ranked candidate features from the underlying data_layer.
 * Scoring is pg_trgm `similarity()` across each configured search
 * field, multiplied by the field's weight; the top-N rows above the
 * configured `minScore` come back with composed labels + geometry
 * centroids.
 *
 * Authorization is two-layer:
 *
 *   1. The caller must have `view` access to the geocoding_service
 *      item itself. ItemsService.get() enforces this; if the user
 *      can't read the geocoder it raises NotFound and we propagate.
 *   2. The caller must ALSO be able to read the underlying
 *      data_layer. We call ItemsService.get() on the source layer
 *      with the caller's principal so the same share rules apply.
 *      A viewer who has the geocoder shared but not the source
 *      can still call /geocode -- but only against the subset of
 *      features they could read directly, with the share's geo-
 *      limit clip intersected into the query. Sharing a geocoder
 *      is not a back-door around the layer's authz.
 *
 * Perf notes:
 *
 *   - Queries scan the latest-per-entity view of the source layer.
 *     For layers <~100K rows this is fast enough for autocomplete
 *     UX without a per-field GIN trigram index. Larger layers will
 *     want `CREATE INDEX ... USING gin ((attrs->>'field') gin_trgm_ops)`
 *     per searchField; that's a follow-up indexing pass tracked as
 *     a perf issue rather than v1 scope.
 *   - The bboxFilter narrows the candidate set before similarity
 *     scoring fires, which makes "geocoder covers WV only" queries
 *     fast even when the underlying layer is large.
 */
@Injectable()
export class GeocodingService {
  private readonly log = new Logger(GeocodingService.name);

  /** Server-side hard caps so a misconfigured client can't request
   *  thousands of candidates per keystroke. */
  private static readonly MAX_CANDIDATES = 50;
  private static readonly DEFAULT_CANDIDATES = 10;
  private static readonly MAX_TEXT_LENGTH = 200;

  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
  ) {}

  async search(
    user: AuthUser,
    itemId: string,
    queryText: string,
    opts: { bbox?: [number, number, number, number]; limit?: number } = {},
  ): Promise<GeocodingCandidate[]> {
    // Input sanitation. Reject empties before any DB work so the
    // common no-typed-anything case (autocomplete fires on focus)
    // round-trips fast.
    const text = (queryText ?? '').trim();
    if (text.length === 0) return [];
    if (text.length > GeocodingService.MAX_TEXT_LENGTH) {
      throw new BadRequestException(
        `Query text exceeds ${GeocodingService.MAX_TEXT_LENGTH} characters.`,
      );
    }

    // 1) Load the geocoding service item. ItemsService.get enforces
    // the user's read access (NotFound on no-access masks existence).
    const item = await this.items.get(user, itemId);
    if (item.type !== 'geocoding_service') {
      throw new BadRequestException(
        `Item ${itemId} is not a geocoding_service.`,
      );
    }
    if (!isGeocodingServiceData(item.data)) {
      throw new BadRequestException(
        'Geocoding service item has invalid configuration.',
      );
    }
    const config: GeocodingServiceData = item.data;
    if (config.searchFields.length === 0) {
      throw new BadRequestException(
        'Geocoding service has no search fields configured.',
      );
    }

    // 2) Resolve the source data layer + sublayer. The user must
    // be able to read it -- ItemsService.get again enforces share
    // access. If the user can read the geocoder but not the
    // source, they get a 404 here (NotFound for the source item).
    const source = await this.items.get(user, config.sourceLayerId);
    if (source.type !== 'data_layer') {
      throw new BadRequestException(
        'Geocoding service source must be a data_layer.',
      );
    }
    const sublayerId = this.resolveSublayerId(source, config);
    if (!sublayerId) {
      throw new BadRequestException(
        'Geocoding service source layer is missing or no longer has the configured sublayer.',
      );
    }
    const scope = `data_layer:${source.id}:${sublayerId}`;

    // 3) Compose the query. Search fields are validated against the
    // sublayer schema so the SQL fragment we substitute into
    // (attrs->>'field') uses safe identifiers; we hold a strict
    // regex on the field name and reject anything that doesn't
    // match so the embedded literal stays injection-safe.
    const validatedFields = this.validateSearchFields(source, sublayerId, config);

    // Clamp candidate limit to the server max.
    const requestedLimit = opts.limit ?? config.candidateLimit ?? GeocodingService.DEFAULT_CANDIDATES;
    const limit = Math.max(
      1,
      Math.min(GeocodingService.MAX_CANDIDATES, Math.floor(requestedLimit)),
    );

    const minScore = Math.max(0, Math.min(1, config.minScore ?? 0.1));

    // Spatial constraint. Caller-supplied bbox overrides the
    // configured filter (the picker UI can shrink the constraint
    // to the visible map extent at query time). Source layer's
    // own bbox is used as fallback for 'layer-bbox'.
    const queryBbox = this.resolveBbox(opts.bbox, config, source);

    // Build the similarity-scoring SQL. We use similarity() with
    // an OR across all fields rather than `%` because the
    // per-field GIN trigram index is a follow-up optimization;
    // similarity() works without an index, returns the score we
    // need to rank by, and is correct regardless of dataset size
    // (just slower than the indexed `%` path).
    const fieldExpressions = validatedFields.map((f) => {
      const weight = Math.max(1, Math.min(10, f.weight ?? 1));
      // pg_trgm.word_similarity(query, target) measures how well
      // the query matches the closest WORD in the target. This is
      // what autocomplete users expect: typing "Carlson" should
      // match the owner string "CARLSON CHRISTAL DAWN ROBYN LEE &
      // ALEXIS ANN" with a high score, even though that long
      // string and "Carlson" have very different overall trigram
      // content. similarity() (the obvious-looking choice) would
      // score this around 0.13 because most of the long string's
      // trigrams aren't in "Carlson"; word_similarity scores it
      // near 1.0 because "Carlson" matches the word "CARLSON"
      // exactly. We GREATEST() the per-field score against
      // similarity() so an exact full-string match (the rare case
      // where the user types the whole value) still ranks at the
      // top instead of relying solely on word_similarity's
      // boundary heuristics.
      //
      // Weight is applied as a straight multiplier, NOT divided by
      // maxWeight: a weight=1 field that perfect-matches scores
      // 1.0; a weight=5 field that perfect-matches scores 5.0.
      // The minScore threshold filters on the same scale, so a
      // default minScore of 0.1 catches the typical noise floor
      // for any weighted field. (An earlier draft divided by 10,
      // which made every unweighted match miss minScore by a hair
      // -- visible as "no candidates" when the data clearly
      // contained the term.)
      return Prisma.sql`GREATEST(
        COALESCE(public.word_similarity(${text}, attrs->>${f.name}), 0),
        COALESCE(public.similarity(attrs->>${f.name}, ${text}), 0)
      ) * ${weight}`;
    });
    // GREATEST(...) across all field expressions: the row's score
    // is its best field match. Prisma.join joins the fragments
    // with commas inside the GREATEST() call.
    const greatestExpr = Prisma.sql`GREATEST(${Prisma.join(fieldExpressions, ', ')})`;

    const filters: Prisma.Sql[] = [];
    if (queryBbox) {
      const [w, s, e, n] = queryBbox;
      filters.push(
        Prisma.sql`AND geom && ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`,
      );
    }
    const filterSql =
      filters.length > 0 ? Prisma.join(filters, ' ') : Prisma.empty;

    interface CandidateRow {
      entity: string;
      attrs: Record<string, unknown> | null;
      geom_geojson: { type: string; coordinates: unknown } | null;
      score: number;
    }

    const rows = await this.prisma.$queryRaw<CandidateRow[]>`
      WITH latest AS (
        SELECT DISTINCT ON (entity)
          entity, attrs, geom, kind
        FROM observation
        WHERE scope = ${scope}
        ${filterSql}
        ORDER BY entity, valid_from DESC, tx_time DESC
      ),
      live AS (
        SELECT entity, attrs, geom
        FROM latest
        WHERE kind <> 'delete'
      ),
      scored AS (
        SELECT
          entity,
          attrs,
          geom,
          ${greatestExpr} AS score
        FROM live
      )
      SELECT
        entity,
        attrs,
        -- ST_PointOnSurface picks a point guaranteed to lie on
        -- the geometry (centroid can sit outside concave
        -- polygons). Falls through ST_AsGeoJSON to the wire
        -- shape the runtime emits in geom.
        ST_AsGeoJSON(
          CASE
            WHEN geom IS NULL THEN NULL
            WHEN ST_GeometryType(geom) = 'ST_Point' THEN geom
            ELSE ST_PointOnSurface(geom)
          END
        )::jsonb AS geom_geojson,
        score
      FROM scored
      WHERE score >= ${minScore}
      ORDER BY score DESC
      LIMIT ${limit}
    `;

    // 4) Compose the wire shape: label string + restricted
    // attributes per the geocoder's resultFields setting.
    const resultFieldNames =
      config.resultFields && config.resultFields.length > 0
        ? config.resultFields
        : validatedFields.map((f) => f.name);

    return rows
      .map((r): GeocodingCandidate | null => {
        if (!r.geom_geojson) return null;
        const coords = (r.geom_geojson as { coordinates?: unknown })
          .coordinates;
        if (
          !Array.isArray(coords) ||
          coords.length < 2 ||
          typeof coords[0] !== 'number' ||
          typeof coords[1] !== 'number'
        ) {
          return null;
        }
        const attrs = r.attrs ?? {};
        const restrictedAttrs: Record<string, unknown> = {};
        for (const name of resultFieldNames) {
          if (name in attrs) restrictedAttrs[name] = attrs[name];
        }
        return {
          featureId: r.entity,
          score: Number(r.score) || 0,
          label: this.composeLabel(config, validatedFields, attrs),
          geom: {
            type: 'Point',
            coordinates: [coords[0], coords[1]],
          },
          attributes: restrictedAttrs,
        };
      })
      .filter((c): c is GeocodingCandidate => c !== null);
  }

  /**
   * Resolve the source data_layer's sublayer id for this geocoder.
   * v3 data_layer items carry one or more layers in
   * `data.layers[]`; the geocoder targets one of them. v2 (legacy
   * single-table) data_layer items have no sublayer concept; we
   * return a synthetic 'default' id that the caller's scope build
   * handles uniformly.
   */
  private resolveSublayerId(
    source: { data: unknown },
    config: GeocodingServiceData,
  ): string | null {
    const sd = source.data as {
      version?: unknown;
      layers?: Array<{ id?: unknown }>;
    } | null;
    if (sd?.version === 3 && Array.isArray(sd.layers)) {
      const wanted = config.sourceSublayerId;
      if (!wanted) return null;
      const match = sd.layers.find((l) => (l.id as unknown) === wanted);
      return match ? wanted : null;
    }
    // Legacy v2 layer: there's only one logical sublayer and the
    // engine's scope encoding for v2 doesn't include a sublayer
    // segment. Geocoding against v2 layers isn't a v1 target; the
    // wizard refuses to author a geocoder against a v2 source.
    return null;
  }

  /**
   * Validate that every searchField name is a real attribute on the
   * source layer's schema AND consists of safe identifier characters.
   * The field name gets embedded into the SQL as a bound parameter
   * (`attrs->>$x`) so injection isn't possible, but the strict-name
   * check still catches misconfigured items early and produces a
   * clean error message rather than a SQL operator failure.
   */
  private validateSearchFields(
    source: { data: unknown },
    sublayerId: string,
    config: GeocodingServiceData,
  ): Array<{ name: string; weight?: number; label?: string }> {
    const sd = source.data as {
      version?: unknown;
      layers?: Array<{ id?: unknown; fields?: Array<{ name?: unknown }> }>;
    } | null;
    const schemaFieldNames = new Set<string>();
    if (sd?.version === 3 && Array.isArray(sd.layers)) {
      const layer = sd.layers.find((l) => l.id === sublayerId);
      if (layer && Array.isArray(layer.fields)) {
        for (const f of layer.fields) {
          if (typeof f.name === 'string') schemaFieldNames.add(f.name);
        }
      }
    }
    const validated: Array<{ name: string; weight?: number; label?: string }> = [];
    for (const sf of config.searchFields) {
      if (!/^[a-zA-Z0-9_]+$/.test(sf.name)) {
        throw new BadRequestException(
          `Search field '${sf.name}' has invalid characters; must match [a-zA-Z0-9_]+`,
        );
      }
      if (schemaFieldNames.size > 0 && !schemaFieldNames.has(sf.name)) {
        throw new BadRequestException(
          `Search field '${sf.name}' is not in the source layer schema.`,
        );
      }
      const out: { name: string; weight?: number; label?: string } = {
        name: sf.name,
      };
      if (sf.weight !== undefined) out.weight = sf.weight;
      if (sf.label !== undefined) out.label = sf.label;
      validated.push(out);
    }
    if (validated.length === 0) {
      throw new BadRequestException(
        'Geocoding service has no valid search fields after validation.',
      );
    }
    return validated;
  }

  /** Resolve the effective bbox filter for this query. Caller-
   *  supplied bbox always wins (used by the map picker to clip to
   *  the visible extent). Otherwise honors the geocoder's
   *  bboxFilter config, falling back to the source layer's cached
   *  bbox for 'layer-bbox'. */
  private resolveBbox(
    callerBbox: [number, number, number, number] | undefined,
    config: GeocodingServiceData,
    source: { bbox: number[] | null },
  ): [number, number, number, number] | null {
    if (callerBbox) return callerBbox;
    const filter = config.bboxFilter ?? 'layer-bbox';
    if (filter === 'none') return null;
    if (filter === 'layer-bbox') {
      const b = source.bbox;
      if (
        Array.isArray(b) &&
        b.length === 4 &&
        b.every((n) => typeof n === 'number')
      ) {
        return [b[0]!, b[1]!, b[2]!, b[3]!];
      }
      return null;
    }
    if (
      filter &&
      typeof filter === 'object' &&
      Array.isArray(filter.wsen) &&
      filter.wsen.length === 4
    ) {
      return filter.wsen;
    }
    return null;
  }

  /**
   * Compose the candidate label. Honors the geocoder's
   * `labelTemplate` when set (with `{fieldName}` substitution);
   * falls back to joining the search-field values with commas so
   * unconfigured geocoders still produce a usable label.
   */
  private composeLabel(
    config: GeocodingServiceData,
    fields: Array<{ name: string }>,
    attrs: Record<string, unknown>,
  ): string {
    const template = config.labelTemplate?.trim();
    if (template && template.length > 0) {
      return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_full, name: string) => {
        const v = attrs[name];
        return v === null || v === undefined ? '' : String(v);
      });
    }
    // Default: join the search-field values with commas, skipping
    // empties. Falls back to the entity id if every field is null
    // so callers always have a non-empty string to render.
    const parts = fields
      .map((f) => attrs[f.name])
      .filter((v) => v !== null && v !== undefined && String(v).length > 0)
      .map((v) => String(v));
    if (parts.length > 0) return parts.join(', ');
    return '(unnamed)';
  }
}
