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
  | { kind: 'text'; value: string };

/**
 * Untrusted shape coming off the wire under `parameters[name]`.
 * The runner translates it to a ResolvedValue or rejects it.
 */
export type ToolRunInput =
  | FeatureSourceValue
  | SpatialPredicate
  | number
  | string;

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
  ) {}

  /**
   * Run a tool recipe on behalf of `user`.  Loads the tool item
   * (gating on read), resolves the parameter values, and executes
   * the pipeline.  Throws NotFoundException if the tool doesn't
   * exist or the caller can't read it.  Throws BadRequestException
   * if the recipe shape is invalid or the request payload doesn't
   * satisfy a required parameter.
   */
  async runSelection(
    user: AuthUser,
    toolId: string,
    request: ToolRunRequest,
  ): Promise<ToolSelectionResult> {
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
    const recipe: RecipeAction = data.action;
    if (recipe.output.kind !== 'selection') {
      // v1: only selection sinks are wired.  Derived-layer and
      // data-layer outputs land in follow-up commits; the type
      // surface allows them so the rest of the schema is stable.
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
  }
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
