// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';

// cedar-wasm/nodejs is a CommonJS bundle that ships its own .d.ts
// shim. Importing it as `* as` avoids a default-export interop
// quirk in @cedar-policy/cedar-wasm 4.x.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

/**
 * The shape of an authorization request the engine asks Cedar to
 * evaluate. Mirrors the AWS Cedar API but keeps the wire shape
 * stable for portal callsites: changing Cedar versions or moving
 * to OPA in a follow-up doesn't ripple into every controller.
 */
export interface PolicyCheckRequest {
  /**
   * Required. The principal asserting the action. The portal
   * always passes a `User` entity with the JWT `sub` as id.
   */
  principal: PolicyEntityRef;
  /**
   * Required. The action being attempted. Portal vocabulary:
   *   { type: 'Action', id: 'read' | 'edit' | 'admin' | 'delete' | 'download' }
   */
  action: PolicyEntityRef;
  /**
   * Required. The resource being acted on. Portal vocabulary:
   *   { type: 'Item', id: '<uuid>' } for item-level checks
   *   { type: 'Lens', id: '<uuid>' } for lens-level checks
   *   { type: 'Feature', id: '<entityUuid>' } for row-level checks
   */
  resource: PolicyEntityRef;
  /**
   * Optional context attributes. Geometry-aware policies pull
   * `context.feature_geom` (GeoJSON) and `context.now` (ISO
   * timestamp) here. The engine fills these in for spatial /
   * temporal predicates the lens declares.
   */
  context?: Record<string, unknown>;
  /**
   * Optional override for the entity store. The portal builds
   * the default store from the principal + resource on every
   * check (cheap, single-org per-request) and merges anything
   * the caller passes in. Lens reads with row-level policies
   * pass per-feature attrs through here.
   */
  entities?: PolicyEntity[];
  /**
   * Optional override for the policies. Defaults to the static
   * org-membership policies. A lens with custom policies passes
   * them in here verbatim; the engine prepends the static
   * baseline so a misauthored lens policy can't escalate
   * privilege past the platform default.
   */
  policiesText?: string;
}

export interface PolicyEntityRef {
  type: string;
  id: string;
}

export interface PolicyEntity {
  uid: PolicyEntityRef;
  attrs?: Record<string, unknown>;
  parents?: PolicyEntityRef[];
}

export type PolicyDecision = 'allow' | 'deny';

export interface PolicyCheckResult {
  decision: PolicyDecision;
  /**
   * Cedar's `reason` list (policy ids that produced the
   * decision). Useful for debugging "why was I denied?"; the API
   * surfaces this in dev mode only.
   */
  reasons: string[];
  /**
   * Errors raised during evaluation. A non-empty list does NOT
   * imply deny by itself: Cedar's semantics are that a runtime
   * error in one policy is ignored if another policy permits.
   * The engine logs these so misauthored lenses surface in the
   * server log instead of silently failing closed.
   */
  errors: string[];
}

/**
 * Cedar-policy-backed authorization. v1 wires the engine in as
 * the evaluator; the call sites that gate item access
 * (SharingService.canRead etc.) still own the decision today
 * and migrate onto PolicyService.check in a Phase A.2 commit
 * once the policy text + entity-store layout is settled.
 *
 * The current implementation is intentionally narrow:
 * `check()` evaluates a fixed baseline policy
 * (org-membership-only, mirroring SharingService.canRead's
 * `access === 'org' && orgId match` branch) plus any policy
 * text the caller passes through. Cedar's WASM is loaded
 * eagerly at module construction; the binding is synchronous
 * so no async init step is needed.
 */
@Injectable()
export class PolicyService {
  private readonly log = new Logger(PolicyService.name);

  constructor() {
    // cedar-wasm exposes synchronous functions; the WASM binary
    // loads on first call. Probe early so a startup failure
    // surfaces at module load instead of on the first
    // authorization check.
    try {
      const sdk = cedar.getCedarSDKVersion();
      const lang = cedar.getCedarLangVersion();
      this.log.log(`Cedar engine ready (sdk=${sdk}, lang=${lang})`);
    } catch (err) {
      this.log.error(
        `Cedar engine failed to initialise: ${
          err instanceof Error ? err.message : err
        }`,
      );
      throw err;
    }
  }

  /**
   * Run an authorization check. Returns `decision: 'allow'` only
   * when at least one policy permits and no policy forbids
   * (Cedar's standard semantics: explicit forbids beat permits;
   * silence is deny).
   */
  check(req: PolicyCheckRequest): PolicyCheckResult {
    const policies = req.policiesText ?? DEFAULT_POLICY_TEXT;
    // Cedar's published TypeScript types model `context` and
    // entity `attrs` as a strict CedarValueJson recursive shape;
    // our wire types use plain `Record<string, unknown>` so
    // existing portal callsites don't have to import cedar types
    // to build a request. Cast at the boundary; the runtime
    // accepts plain JSON objects (verified via the spec suite
    // and the cedar-probe smoke test).
    const result = cedar.isAuthorized({
      principal: req.principal,
      action: req.action,
      resource: req.resource,
      context: (req.context ?? {}) as Parameters<
        typeof cedar.isAuthorized
      >[0]['context'],
      policies: { staticPolicies: policies },
      entities: (req.entities ?? []) as Parameters<
        typeof cedar.isAuthorized
      >[0]['entities'],
    });
    if (result.type === 'failure') {
      const messages = (result.errors ?? []).map((e) => {
        const m = (e as unknown as { message?: unknown }).message;
        return typeof m === 'string' ? m : JSON.stringify(e);
      });
      this.log.warn(
        `Cedar check failed for ${req.principal.type}::${req.principal.id} ` +
          `${req.action.type}::${req.action.id} ` +
          `${req.resource.type}::${req.resource.id}: ${messages.join('; ')}`,
      );
      return { decision: 'deny', reasons: [], errors: messages };
    }
    const response = result.response;
    return {
      decision: response.decision === 'allow' ? 'allow' : 'deny',
      reasons: response.diagnostics?.reason ?? [],
      errors: (response.diagnostics?.errors ?? []).map((e) => {
        const m = (e as unknown as { message?: unknown }).message;
        return typeof m === 'string' ? m : String(e);
      }),
    };
  }
}

/**
 * Baseline policy text. Mirrors today's SharingService behaviour
 * for the cases SharingService gates today: owner-of-resource and
 * same-org access. Explicit per-share grants live in the database
 * (item_share rows) and aren't expressible as a static policy
 * without an entity-store hop, so they get added at check time
 * by the caller via `req.entities` + a per-share `permit` rule.
 *
 * Until Phase A.2 migrates SharingService onto PolicyService.check,
 * this policy is exercised only by tests; runtime authorization
 * still flows through SharingService.
 */
export const DEFAULT_POLICY_TEXT = `
// Owners can do anything to their own items. The portal's
// EntityStore writes resource.owner as an entity reference
// (User::"<uuid>"), not as a plain string, so an entity-ref
// comparison is what matches; principal.id and similar
// attribute lookups are NOT available in Cedar (the entity uid
// is only reachable via == against another entity literal).
permit (
  principal,
  action,
  resource
) when {
  resource has owner &&
  principal == resource.owner
};

// Org admins can do anything to items inside their org. Both
// principal.org and resource.org are entity refs (Org::"<uuid>")
// so the equality check is between two entity literals, not
// between strings.
permit (
  principal,
  action,
  resource
) when {
  resource has org &&
  principal has org &&
  principal.org == resource.org &&
  principal has role &&
  principal.role == "admin"
};

// Public items are readable by anyone authenticated.
permit (
  principal,
  action == Action::"read",
  resource
) when {
  resource has access &&
  resource.access == "public"
};

// Org-access items are readable by org members.
permit (
  principal,
  action == Action::"read",
  resource
) when {
  resource has access &&
  resource.access == "org" &&
  resource has org &&
  principal has org &&
  principal.org == resource.org
};
`;
