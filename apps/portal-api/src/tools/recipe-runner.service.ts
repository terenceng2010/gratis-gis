// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  DistanceRef,
  FeatureSourceValue,
  OsmTagFilter,
  PredicateRef,
  RecipeAction,
  SourceRef,
  SpatialPredicate,
  ToolItemData,
  ToolParameter,
  ToolStep,
} from '@gratis-gis/shared-types';
import { DEFAULT_TOOL_SELECTION_LIMIT } from '@gratis-gis/shared-types';

import {
  dataLayerScope,
  dataLayerSourceSqlFragment,
} from '../engine/data-layer.js';
import { ItemsService } from '../items/items.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { getGeneratorForStep } from '../derived-layers/tools/registry.js';
import { OsmService } from '../osm/osm.service.js';
import type { OsmGeoJsonFeature } from '../osm/osm-to-geojson.js';

/**
 * Per-parameter resolved value: the runtime-supplied input merged
 * with the parameter's binding-defined default.  The recipe runner
 * resolves every parameter exactly once at the top of a run, then
 * walks the pipeline substituting these values into step params.
 */
export type ResolvedValue =
  | { kind: 'feature-source'; value: FeatureSourceValue }
  | { kind: 'predicate'; value: SpatialPredicate }
  | { kind: 'distance'; meters: number }
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | {
      kind: 'osm-feature';
      presetIds: string[];
      tagFilters?: OsmTagFilter[];
      /** #101: per-recipe TTL override in minutes (0 = always fresh). */
      ttlMinutes?: number;
    };

/**
 * Untrusted shape coming off the wire under `parameters[name]`.
 * The runner translates it to a ResolvedValue or rejects it.  OSM
 * inputs carry the user's runtime picks (which preset ids + which
 * tag filters); hardcoded osm-feature parameters resolve from
 * their binding without an input row.
 */
export type ToolRunInput =
  | FeatureSourceValue
  | SpatialPredicate
  | number
  | string
  | {
      kind: 'osm-feature-input';
      presetIds: string[];
      tagFilters?: OsmTagFilter[];
      /** #101: per-recipe TTL override in minutes (0 = always fresh). */
      ttlMinutes?: number;
    };

export interface ToolRunRequest {
  parameters: Record<string, ToolRunInput>;
}

export interface ToolSelectionResult {
  output: {
    kind: 'selection';
    /** Resolved layer (data_layer / derived_layer item id + sublayer
     *  key) the selection applies to.  Mirrors the host map's layer
     *  identity so the client can update the right selection slot. */
    layer: { itemId: string; layerKey?: string };
    /** Matching feature ids in the selection layer. */
    featureIds: Array<string | number>;
    /** True when more rows existed than the cap; the UI surfaces a
     *  banner so the user knows the selection is incomplete. */
    truncated: boolean;
  };
}

export interface ToolOsmOverlayResult {
  output: {
    kind: 'osm-features-overlay';
    /** GeoJSON features (Points / LineStrings / Polygons /
     *  MultiPolygons) the host map should render as a transient
     *  overlay.  Always carries the OSM attribution string the UI
     *  must surface alongside the rendered features (ODbL). */
    features: OsmGeoJsonFeature[];
    /** © OpenStreetMap contributors string the runtime surfaces
     *  next to the overlay. */
    attribution: string;
    /** Total fetched count (pre any post-filter steps).  Matches
     *  `features.length` in v1 since the pipeline either keeps or
     *  drops features, no post-fetch attribute decoration yet. */
    featureCount: number;
    /** True when the underlying Overpass response hit the
     *  per-query cap.  UI banner so the user knows to tighten the
     *  AOI / filters. */
    truncated: boolean;
  };
}

export type ToolRunResult = ToolSelectionResult | ToolOsmOverlayResult;

/**
 * Tool recipe runner (#90).  Resolves runtime parameter inputs,
 * substitutes them into the pipeline's parameter references, and
 * runs the resulting concrete pipeline as SQL against PostGIS.
 *
 * v1 supports `output.kind === 'selection'`: the pipeline's final
 * CTE is projected to `global_id`, capped at `selectionLimit`, and
 * returned to the caller.  `derived-layer` and `data-layer` output
 * sinks land in follow-up commits.
 *
 * The runner relies on the same tool generator registry that
 * derived_layer uses for its read path.  This keeps the two
 * vocabularies in sync at the SQL-compilation layer: any step that
 * works in a derived_layer pipeline works inside a tool recipe.
 */
@Injectable()
export class RecipeRunnerService {
  private readonly logger = new Logger(RecipeRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly osm: OsmService,
  ) {}

  /**
   * Top-level entry point used by the controller.  Loads the tool,
   * runs the recipe, and branches on the output sink to produce
   * either a selection update or an OSM-features overlay response.
   */
  async run(
    user: AuthUser,
    toolId: string,
    request: ToolRunRequest,
  ): Promise<ToolRunResult> {
    const { recipe } = await this.loadRecipe(user, toolId);
    if (recipe.output.kind === 'selection') {
      return this.runSelectionInternal(user, toolId, recipe, request);
    }
    if (recipe.output.kind === 'osm-features-overlay') {
      // #103: thread the running user's orgId so OsmService can
      // look up the per-org Overpass endpoint override.
      return this.runOsmOverlayInternal(recipe, request, user);
    }
    throw new BadRequestException(
      `Tool ${toolId} has an unsupported output sink: ${recipe.output.kind}`,
    );
  }

  /**
   * Run a tool recipe on behalf of `user`.  Loads the tool item
   * (gating on read), resolves the parameter values, and executes
   * the pipeline.  Throws NotFoundException if the tool doesn't
   * exist or the caller can't read it.  Throws BadRequestException
   * if the recipe shape is invalid or the request payload doesn't
   * satisfy a required parameter.
   *
   * Kept exported (alongside the new `run` entry point) for the
   * existing controller path; new callers should prefer `run()`
   * which auto-branches on the output sink.
   */
  /**
   * Load the tool item via the ACL-gated items service and return
   * its recipe action.  Throws when the item isn't a tool or doesn't
   * have a recipe action; the caller doesn't have to care about
   * which.
   */
  private async loadRecipe(
    user: AuthUser,
    toolId: string,
  ): Promise<{ recipe: RecipeAction }> {
    const tool = await this.items.get(user, toolId);
    if (tool.type !== 'tool') {
      throw new BadRequestException(`Item ${toolId} is not a tool`);
    }
    const data = tool.data as unknown as ToolItemData | null;
    if (!data || data.action.kind !== 'recipe') {
      throw new BadRequestException(
        `Tool ${toolId} does not have a recipe action`,
      );
    }
    return { recipe: data.action };
  }

  async runSelection(
    user: AuthUser,
    toolId: string,
    request: ToolRunRequest,
  ): Promise<ToolSelectionResult> {
    const { recipe } = await this.loadRecipe(user, toolId);
    return this.runSelectionInternal(user, toolId, recipe, request);
  }

  private async runSelectionInternal(
    user: AuthUser,
    toolId: string,
    recipe: RecipeAction,
    request: ToolRunRequest,
  ): Promise<ToolSelectionResult> {
    if (recipe.output.kind !== 'selection') {
      throw new BadRequestException(
        `Tool ${toolId} has an unsupported output sink: ${recipe.output.kind}`,
      );
    }

    // Resolve every parameter once up front.  Missing optional
    // parameters resolve to undefined; missing required parameters
    // throw.  The resolved map drives every substitution downstream.
    const resolved = resolveParameters(recipe.parameters, request.parameters);

    // The output's targetParameterRef names the parameter whose
    // resolved value is the layer the selection applies to.  Without
    // that, we don't know which selection slot to update.
    const target = resolved.get(recipe.output.targetParameterRef);
    if (!target || target.kind !== 'feature-source') {
      throw new BadRequestException(
        `Recipe output references parameter '${recipe.output.targetParameterRef}' but that parameter is not a feature-source`,
      );
    }
    const targetSource = target.value;
    if (targetSource.kind !== 'data_layer' && targetSource.kind !== 'derived_layer') {
      throw new BadRequestException(
        `Selection output requires a data_layer or derived_layer target; got ${targetSource.kind}`,
      );
    }
    if (!targetSource.itemId) {
      throw new BadRequestException(
        'Selection output target parameter is missing an itemId',
      );
    }

    // Read the target layer item to gate access -- a user could
    // hold read on the tool but not on the layer it operates on.
    const targetItem = await this.items.get(user, targetSource.itemId);
    if (
      targetItem.type !== 'data_layer' &&
      targetItem.type !== 'derived_layer'
    ) {
      throw new BadRequestException(
        `Selection target ${targetSource.itemId} is not a data_layer or derived_layer`,
      );
    }
    // derived_layer targets follow-up: the selection executor below
    // only handles data_layer targets in v1 because that's where the
    // engine fragment lives.  derived_layer targets need to compose
    // the source recipe's CTEs first, which is the same chain walk
    // DerivedLayersService.getGeoJson does.  Out of scope for the
    // recipe-runner MVP; revisit when extending.
    if (targetItem.type !== 'data_layer') {
      throw new BadRequestException(
        'Selection against a derived_layer is not yet supported; aim the target parameter at a data_layer',
      );
    }

    // Build CTEs: source from the target data_layer + each step.
    const layerKey = targetSource.layerKey ?? 'default';
    const sqlParams: unknown[] = [];
    const sourceScope = dataLayerScope(targetSource.itemId, layerKey);
    const sourceConditions = ['valid_to IS NULL'];
    if (
      targetSource.featureIds &&
      Array.isArray(targetSource.featureIds) &&
      targetSource.featureIds.length > 0
    ) {
      // Selection-from-current-selection workflow: the target
      // parameter resolved to "these specific features" rather than
      // "the whole layer", so we pre-restrict the source rows.
      sqlParams.push(targetSource.featureIds);
      sourceConditions.push(`entity = ANY($${sqlParams.length}::text[])`);
    }
    const sourceFragment = dataLayerSourceSqlFragment(sourceScope, {
      extraConditions: sourceConditions,
    });

    const ctes: string[] = [`tool_source AS (${sourceFragment})`];
    let inputAlias = 'tool_source';

    // Walk the pipeline, substituting parameter refs in each step's
    // params with their resolved values, then handing the substituted
    // params to the existing tool generator.  This is the moment the
    // recipe vocabulary becomes a derived_layer-shaped pipeline.
    const concretePipeline = recipe.pipeline.map((step) =>
      substituteStep(step, resolved),
    );
    for (let i = 0; i < concretePipeline.length; i++) {
      const step = concretePipeline[i]!;
      const generator = getGeneratorForStep(step);
      const stepParams = generator.validate(step.params);
      const fragment = generator.toSql(inputAlias, stepParams, sqlParams.length);
      const cteName = `tool_step_${i + 1}`;
      ctes.push(`${cteName} AS (${fragment.sql})`);
      sqlParams.push(...fragment.params);
      inputAlias = cteName;
    }

    const cap = recipe.selectionLimit ?? DEFAULT_TOOL_SELECTION_LIMIT;
    // SELECT one row past the cap so the response can flag truncation
    // without a second COUNT query.  LIMIT cap+1 keeps the SQL planner
    // honest on huge intersections.
    sqlParams.push(cap + 1);
    const limitPlaceholder = `$${sqlParams.length}`;
    const sql = `
      WITH ${ctes.join(', ')}
      SELECT global_id
      FROM ${inputAlias}
      WHERE geom IS NOT NULL
      LIMIT ${limitPlaceholder}
    `;

    let rows: Array<{ global_id: string }>;
    try {
      rows = await this.prisma.$queryRawUnsafe<{ global_id: string }[]>(
        sql,
        ...sqlParams,
      );
    } catch (err) {
      // Surface SQL failures as 400s with a stable hint rather than
      // a 500 -- the caller's recipe + params are usually the cause,
      // not infrastructure.  The full SQL goes to the server log for
      // debugging; the response stays terse so it doesn't leak shape.
      this.logger.warn(
        `recipe-runner SQL failure for tool ${toolId}: ${(err as Error).message}`,
      );
      throw new BadRequestException(
        `Tool execution failed: ${(err as Error).message}`,
      );
    }

    const truncated = rows.length > cap;
    const featureIds = rows.slice(0, cap).map((r) => r.global_id);

    return {
      output: {
        kind: 'selection',
        layer: {
          itemId: targetSource.itemId,
          ...(targetSource.layerKey !== undefined
            ? { layerKey: targetSource.layerKey }
            : {}),
        },
        featureIds,
        truncated,
      },
    };
  }

  /**
   * OSM-features-overlay output path (#OSM).  Returns the OSM
   * features Overpass produces for a bbox derived from the
   * recipe's AOI parameter, plus the user's chosen presets +
   * tag filters.  v1 returns ALL features inside the bbox; finer
   * spatial filtering (distance, contains, etc.) lands in wave 2
   * when the spatial-filter generator gains a transient-scope
   * source kind that consumes the OSM scope.
   */
  private async runOsmOverlayInternal(
    recipe: RecipeAction,
    request: ToolRunRequest,
    user: AuthUser,
  ): Promise<ToolOsmOverlayResult> {
    if (recipe.output.kind !== 'osm-features-overlay') {
      throw new BadRequestException(
        `runOsmOverlayInternal called with the wrong output kind: ${recipe.output.kind}`,
      );
    }
    const resolved = resolveParameters(recipe.parameters, request.parameters);

    if (!recipe.sourceParameterRef) {
      throw new BadRequestException(
        'osm-features-overlay output requires recipe.sourceParameterRef pointing at an osm-feature parameter',
      );
    }
    const sourceVal = resolved.get(recipe.sourceParameterRef);
    if (!sourceVal || sourceVal.kind !== 'osm-feature') {
      throw new BadRequestException(
        `Recipe sourceParameterRef '${recipe.sourceParameterRef}' must resolve to an osm-feature parameter`,
      );
    }

    if (!recipe.aoiParameterRef) {
      throw new BadRequestException(
        'osm-features-overlay output requires recipe.aoiParameterRef pointing at the area-of-interest parameter',
      );
    }
    const aoiVal = resolved.get(recipe.aoiParameterRef);
    if (!aoiVal || aoiVal.kind !== 'feature-source') {
      throw new BadRequestException(
        `Recipe aoiParameterRef '${recipe.aoiParameterRef}' must resolve to a feature-source parameter`,
      );
    }
    // Compute the AOI's bbox.  v1 supports inline-geojson AOIs (the
    // user drew on the map) directly.  data_layer / runtime-selection
    // AOIs need a PostGIS ST_Envelope read; queued for wave 2 with
    // the spatial-filter integration.
    const bbox = await this.computeAoiBbox(aoiVal.value);
    if (!bbox) {
      throw new BadRequestException(
        `Could not compute a bbox from AOI parameter '${recipe.aoiParameterRef}'.  v1 only supports inline-geojson AOIs (drawn on the map).  Layer / selection AOIs land in wave 2.`,
      );
    }

    // Optional distance buffer: when the recipe declares a distance
    // parameter, pad the bbox by that amount before the Overpass
    // call so features just outside the AOI but within distance are
    // still returned.  The cheap conversion (meters → degrees at
    // 1deg ≈ 111km) over-pads slightly at high latitudes; acceptable
    // for the v1 "show me things near my parcel" use case.
    const distance = findDistanceParam(recipe.parameters, resolved);
    const padDegrees = distance ? distance / 111_000 : 0;
    const paddedBbox: [number, number, number, number] = [
      bbox[0] - padDegrees,
      bbox[1] - padDegrees,
      bbox[2] + padDegrees,
      bbox[3] + padDegrees,
    ];

    // #101: per-recipe TTL override. Clamped to a sane range so a
    // typo in the recipe (e.g. 999999) can't permanently pin a stale
    // scope. 0 means "always fresh" (skip the cache); we map that to
    // ttlMs=0 which the resolver treats as "never cache hit, always
    // refetch + overwrite the cache row with a fresh expiresAt".
    let ttlMs: number | undefined;
    if (typeof sourceVal.ttlMinutes === 'number' && Number.isFinite(sourceVal.ttlMinutes)) {
      const minutes = Math.max(0, Math.min(7 * 24 * 60, sourceVal.ttlMinutes));
      ttlMs = minutes * 60 * 1000;
    }

    const result = await this.osm.resolve({
      presetIds: sourceVal.presetIds,
      ...(sourceVal.tagFilters && sourceVal.tagFilters.length > 0
        ? { tagFilters: sourceVal.tagFilters }
        : {}),
      bbox: paddedBbox,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      // #103: per-org Overpass endpoint lookup happens inside
      // OsmService when orgId is supplied. The user is the running
      // principal so their org is the one whose setting wins.
      ...(user.orgId ? { orgId: user.orgId } : {}),
    });

    return {
      output: {
        kind: 'osm-features-overlay',
        features: result.features,
        attribution: result.attribution,
        featureCount: result.featureCount,
        truncated: false, // wave 2 surface when Overpass actually hit the cap
      },
    };
  }

  /**
   * Compute the bounding box of an AOI feature-source value.
   *
   * v1 supports inline-geojson AOIs (drawn polygons / rectangles
   * etc).  Layer / selection AOIs need a PostGIS hop; queued for
   * wave 2 alongside the spatial-filter integration.  Returns null
   * when the bbox can't be computed.
   */
  private async computeAoiBbox(
    value: FeatureSourceValue,
  ): Promise<[number, number, number, number] | null> {
    if (value.kind === 'inline-geojson' && value.geojson) {
      return bboxOfGeoJson(value.geojson);
    }
    // TODO (wave 2): for data_layer / derived_layer AOIs, compute
    // bbox via ST_Extent(geom) WHERE entity = ANY(featureIds) OR
    // the whole layer when featureIds is empty.  For now we refuse
    // so the user knows what's supported.
    return null;
  }
}

// ----------------------------------------------------------------------
// Parameter resolution + step substitution.  Pure functions split out
// so the test suite can exercise them without a Prisma instance.
// ----------------------------------------------------------------------

/**
 * Resolve every parameter declared on the recipe against the
 * request's parameter map.  Required parameters that don't have a
 * value (and no binding default) raise a BadRequestException.
 * Optional parameters that aren't supplied resolve to whatever the
 * binding's default is, or are skipped entirely.
 */
export function resolveParameters(
  declarations: ToolParameter[],
  supplied: Record<string, ToolRunInput>,
): Map<string, ResolvedValue> {
  const resolved = new Map<string, ResolvedValue>();
  for (const param of declarations) {
    const provided = supplied[param.name];
    const value = resolveOne(param, provided);
    if (value !== undefined) {
      resolved.set(param.name, value);
    } else if (param.required) {
      throw new BadRequestException(
        `Required parameter '${param.name}' is missing`,
      );
    }
  }
  return resolved;
}

function resolveOne(
  param: ToolParameter,
  provided: ToolRunInput | undefined,
): ResolvedValue | undefined {
  switch (param.kind) {
    case 'feature-source':
      return resolveFeatureSource(param, provided);
    case 'predicate':
      return resolvePredicateParam(param, provided);
    case 'distance':
      return resolveDistanceParam(param, provided);
    case 'number':
      return resolveNumberParam(param, provided);
    case 'text':
      return resolveTextParam(param, provided);
    case 'osm-feature':
      return resolveOsmFeatureParam(param, provided);
  }
}

function resolveOsmFeatureParam(
  param: Extract<ToolParameter, { kind: 'osm-feature' }>,
  provided: ToolRunInput | undefined,
): ResolvedValue | undefined {
  // Hardcoded binding: ignore whatever the client sent and use the
  // baked-in preset / filter set.  This is what a "Find pharmacies
  // near my facility" tool with no user discretion looks like.
  if (param.binding.mode === 'hardcoded') {
    return {
      kind: 'osm-feature',
      presetIds: param.binding.presetIds,
      ...(param.binding.tagFilters && param.binding.tagFilters.length > 0
        ? { tagFilters: param.binding.tagFilters }
        : {}),
      ...(typeof param.ttlMinutes === 'number'
        ? { ttlMinutes: param.ttlMinutes }
        : {}),
    };
  }
  // runtime-pick: client sent {kind:'osm-feature-input', presetIds, tagFilters}.
  // Fall back to defaults when omitted.
  if (
    provided !== undefined &&
    typeof provided === 'object' &&
    provided !== null &&
    'kind' in provided &&
    (provided as { kind?: string }).kind === 'osm-feature-input'
  ) {
    const input = provided as {
      kind: 'osm-feature-input';
      presetIds?: string[];
      tagFilters?: OsmTagFilter[];
    };
    if (!Array.isArray(input.presetIds) || input.presetIds.length === 0) {
      throw new BadRequestException(
        `Parameter '${param.name}': presetIds must be a non-empty array`,
      );
    }
    if (
      param.binding.allowedPresetIds &&
      param.binding.allowedPresetIds.length > 0
    ) {
      for (const id of input.presetIds) {
        if (!param.binding.allowedPresetIds.includes(id)) {
          throw new BadRequestException(
            `Parameter '${param.name}': preset '${id}' is not in the allowed list`,
          );
        }
      }
    }
    if (
      input.tagFilters &&
      input.tagFilters.length > 0 &&
      param.binding.allowCustomTagFilters === false
    ) {
      throw new BadRequestException(
        `Parameter '${param.name}' does not allow custom tag filters`,
      );
    }
    return {
      kind: 'osm-feature',
      presetIds: input.presetIds,
      ...(input.tagFilters && input.tagFilters.length > 0
        ? { tagFilters: input.tagFilters }
        : {}),
      // The recipe author's TTL setting wins over any runtime
      // ttlMinutes the client tried to set: the recipe is the
      // contract; clients can't override caching behavior just by
      // POSTing a different number. (If we wanted user-tunable
      // freshness we'd surface it as a separate parameter.)
      ...(typeof param.ttlMinutes === 'number'
        ? { ttlMinutes: param.ttlMinutes }
        : {}),
    };
  }
  // No input + runtime-pick: fall through to the binding defaults.
  if (
    param.binding.defaultPresetIds &&
    param.binding.defaultPresetIds.length > 0
  ) {
    return {
      kind: 'osm-feature',
      presetIds: param.binding.defaultPresetIds,
      ...(param.binding.defaultTagFilters &&
      param.binding.defaultTagFilters.length > 0
        ? { tagFilters: param.binding.defaultTagFilters }
        : {}),
      ...(typeof param.ttlMinutes === 'number'
        ? { ttlMinutes: param.ttlMinutes }
        : {}),
    };
  }
  return undefined;
}

function resolveFeatureSource(
  param: Extract<ToolParameter, { kind: 'feature-source' }>,
  provided: ToolRunInput | undefined,
): ResolvedValue | undefined {
  if (provided !== undefined && typeof provided === 'object' && provided !== null) {
    const v = provided as FeatureSourceValue;
    if (
      v.kind !== 'data_layer' &&
      v.kind !== 'derived_layer' &&
      v.kind !== 'inline-geojson'
    ) {
      throw new BadRequestException(
        `Parameter '${param.name}' must be a FeatureSourceValue with kind data_layer, derived_layer, or inline-geojson`,
      );
    }
    return { kind: 'feature-source', value: v };
  }
  // Fall back to binding-defined defaults.
  if (param.binding.mode === 'hardcoded') {
    return { kind: 'feature-source', value: param.binding.value };
  }
  if (
    param.binding.mode === 'runtime-host' &&
    param.binding.defaultValue !== undefined
  ) {
    return { kind: 'feature-source', value: param.binding.defaultValue };
  }
  return undefined;
}

function resolvePredicateParam(
  param: Extract<ToolParameter, { kind: 'predicate' }>,
  provided: ToolRunInput | undefined,
): ResolvedValue | undefined {
  if (typeof provided === 'string') {
    const value = provided as SpatialPredicate;
    if (
      param.binding.mode === 'runtime-pick' &&
      param.binding.allowed &&
      !param.binding.allowed.includes(value)
    ) {
      throw new BadRequestException(
        `Parameter '${param.name}' value '${value}' is not in the allowed set`,
      );
    }
    return { kind: 'predicate', value };
  }
  if (param.binding.mode === 'hardcoded') {
    return { kind: 'predicate', value: param.binding.value };
  }
  if (param.binding.mode === 'runtime-pick') {
    return { kind: 'predicate', value: param.binding.defaultValue };
  }
  return undefined;
}

function resolveDistanceParam(
  param: Extract<ToolParameter, { kind: 'distance' }>,
  provided: ToolRunInput | undefined,
): ResolvedValue | undefined {
  let meters: number | undefined;
  if (typeof provided === 'number') {
    meters = provided;
  } else if (param.binding.mode === 'hardcoded') {
    meters = param.binding.meters;
  } else if (param.binding.mode === 'runtime-input') {
    meters = param.binding.defaultMeters;
  }
  if (meters === undefined) return undefined;
  if (!Number.isFinite(meters) || meters <= 0) {
    throw new BadRequestException(
      `Parameter '${param.name}' must be a positive finite number of meters`,
    );
  }
  if (param.binding.mode === 'runtime-input') {
    const { minMeters, maxMeters } = param.binding;
    if (minMeters !== undefined && meters < minMeters) {
      throw new BadRequestException(
        `Parameter '${param.name}' must be at least ${minMeters} meters`,
      );
    }
    if (maxMeters !== undefined && meters > maxMeters) {
      throw new BadRequestException(
        `Parameter '${param.name}' must be at most ${maxMeters} meters`,
      );
    }
  }
  return { kind: 'distance', meters };
}

function resolveNumberParam(
  param: Extract<ToolParameter, { kind: 'number' }>,
  provided: ToolRunInput | undefined,
): ResolvedValue | undefined {
  let value: number | undefined;
  if (typeof provided === 'number') value = provided;
  else if (param.binding.mode === 'hardcoded') value = param.binding.value;
  else if (param.binding.mode === 'runtime-input')
    value = param.binding.defaultValue;
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) {
    throw new BadRequestException(
      `Parameter '${param.name}' must be a finite number`,
    );
  }
  if (param.binding.mode === 'runtime-input') {
    const { min, max } = param.binding;
    if (min !== undefined && value < min) {
      throw new BadRequestException(
        `Parameter '${param.name}' must be at least ${min}`,
      );
    }
    if (max !== undefined && value > max) {
      throw new BadRequestException(
        `Parameter '${param.name}' must be at most ${max}`,
      );
    }
  }
  return { kind: 'number', value };
}

function resolveTextParam(
  param: Extract<ToolParameter, { kind: 'text' }>,
  provided: ToolRunInput | undefined,
): ResolvedValue | undefined {
  if (typeof provided === 'string') {
    return { kind: 'text', value: provided };
  }
  if (param.binding.mode === 'hardcoded') {
    return { kind: 'text', value: param.binding.value };
  }
  if (
    param.binding.mode === 'runtime-input' &&
    typeof param.binding.defaultValue === 'string'
  ) {
    return { kind: 'text', value: param.binding.defaultValue };
  }
  return undefined;
}

/**
 * Walk a step's params and replace every `{ kind: 'parameter', name }`
 * reference with the resolved value.  Returns a new step with the
 * resolved-shape params; the generator's `validate` consumes it.
 *
 * The substitution is intentionally narrow: only spatial-filter
 * accepts parameter refs in v1, so we walk only its known fields.
 * If the union grows (e.g. parameterized distance on buffer), extend
 * here.  Doing this explicitly rather than via a deep walk avoids
 * accidentally substituting structural keys that happen to be named
 * `parameter` somewhere in a future step's params.
 */
export function substituteStep(
  step: ToolStep,
  resolved: Map<string, ResolvedValue>,
): ToolStep {
  if (step.tool === 'spatial-filter') {
    const p = step.params;
    return {
      tool: 'spatial-filter',
      params: {
        otherSource: substituteSourceRef(p.otherSource, resolved),
        predicate: substitutePredicateRef(p.predicate, resolved),
        ...(p.distance !== undefined
          ? { distance: substituteDistanceRef(p.distance, resolved) }
          : {}),
      },
    };
  }
  return step;
}

function substituteSourceRef(
  ref: SourceRef,
  resolved: Map<string, ResolvedValue>,
): SourceRef {
  if (ref.kind !== 'parameter') return ref;
  const value = resolved.get(ref.name);
  if (!value) {
    throw new BadRequestException(
      `spatial-filter references parameter '${ref.name}' but the parameter has no resolved value`,
    );
  }
  if (value.kind !== 'feature-source') {
    throw new BadRequestException(
      `spatial-filter.otherSource expected a feature-source parameter for '${ref.name}', got ${value.kind}`,
    );
  }
  const fs = value.value;
  if (fs.kind === 'inline-geojson') {
    if (fs.geojson === undefined) {
      throw new BadRequestException(
        `inline-geojson parameter '${ref.name}' has no geometry`,
      );
    }
    return { kind: 'inline-geometry', geometry: fs.geojson };
  }
  if (fs.kind === 'data_layer' || fs.kind === 'derived_layer') {
    if (!fs.itemId) {
      throw new BadRequestException(
        `feature-source parameter '${ref.name}' is missing an itemId`,
      );
    }
    // SpatialFilterStep's data_layer source only supports
    // data_layer; if the user wired a derived_layer here, fall
    // through to a clear error rather than silently misreading.
    if (fs.kind === 'derived_layer') {
      throw new BadRequestException(
        `spatial-filter.otherSource cannot point at a derived_layer yet; pick a data_layer`,
      );
    }
    return {
      kind: 'data_layer',
      itemId: fs.itemId,
      ...(fs.layerKey ? { layerKey: fs.layerKey } : {}),
      ...(fs.featureIds && fs.featureIds.length > 0
        ? { featureIds: fs.featureIds }
        : {}),
    };
  }
  throw new BadRequestException(
    `feature-source parameter '${ref.name}' has unsupported kind '${(fs as { kind?: string }).kind ?? 'unknown'}'`,
  );
}

function substitutePredicateRef(
  ref: PredicateRef,
  resolved: Map<string, ResolvedValue>,
): PredicateRef {
  if (ref.kind !== 'parameter') return ref;
  const value = resolved.get(ref.name);
  if (!value) {
    throw new BadRequestException(
      `spatial-filter references predicate parameter '${ref.name}' but it has no resolved value`,
    );
  }
  if (value.kind !== 'predicate') {
    throw new BadRequestException(
      `spatial-filter.predicate expected a predicate parameter for '${ref.name}', got ${value.kind}`,
    );
  }
  return { kind: 'fixed', value: value.value };
}

function substituteDistanceRef(
  ref: DistanceRef,
  resolved: Map<string, ResolvedValue>,
): DistanceRef {
  if (ref.kind !== 'parameter') return ref;
  const value = resolved.get(ref.name);
  if (!value) {
    throw new BadRequestException(
      `spatial-filter references distance parameter '${ref.name}' but it has no resolved value`,
    );
  }
  if (value.kind !== 'distance') {
    throw new BadRequestException(
      `spatial-filter.distance expected a distance parameter for '${ref.name}', got ${value.kind}`,
    );
  }
  return { kind: 'fixed', meters: value.meters };
}

/**
 * Find the first distance parameter the recipe declares and look
 * up its resolved meters value.  Used by the osm-overlay runner to
 * pad the AOI bbox so features just outside the AOI are still in
 * scope.  Returns null when the recipe has no distance parameter,
 * or has one that didn't resolve (optional + no default + no
 * input).
 */
function findDistanceParam(
  declarations: ToolParameter[],
  resolved: Map<string, ResolvedValue>,
): number | null {
  for (const p of declarations) {
    if (p.kind !== 'distance') continue;
    const v = resolved.get(p.name);
    if (v && v.kind === 'distance') return v.meters;
  }
  return null;
}

/**
 * Compute the axis-aligned bbox of a GeoJSON value.  Accepts a
 * bare Geometry, a Feature, or a FeatureCollection.  Returns null
 * when the shape has no coordinates (e.g. an empty
 * GeometryCollection).
 */
function bboxOfGeoJson(
  geojson: unknown,
): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (coord: unknown): void => {
    if (Array.isArray(coord)) {
      if (typeof coord[0] === 'number' && typeof coord[1] === 'number') {
        if (coord[0] < minX) minX = coord[0];
        if (coord[1] < minY) minY = coord[1];
        if (coord[0] > maxX) maxX = coord[0];
        if (coord[1] > maxY) maxY = coord[1];
      } else {
        for (const c of coord) visit(c);
      }
    }
  };
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n.type === 'FeatureCollection' && Array.isArray(n.features)) {
      for (const f of n.features) walk(f);
      return;
    }
    if (n.type === 'Feature') {
      walk(n.geometry);
      return;
    }
    if (Array.isArray(n.coordinates)) {
      visit(n.coordinates);
    }
  }
  walk(geojson);
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null;
  }
  return [minX, minY, maxX, maxY];
}
