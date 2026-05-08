# Cedar policy integration

The engine pivot defers the open question "policy engine choice"
in `observation-log-engine.md` (section 7) to Phase A of the
authorization rebuild. This doc closes that question and lays out
the integration plan.

## Decision

We picked Cedar (`@cedar-policy/cedar-wasm`) over OPA and a
hand-rolled DSL. Reasoning:

- **Geometry- and attribute-aware checks are first-class.** Cedar
  policies can compare entity references and JSON-encoded
  attributes natively (`principal.org == resource.org`,
  `resource.geom.area > 1000`). The eventual "contractors only see
  parcels inside their assigned polygon" rule is a single Cedar
  permit.
- **One dependency.** WASM ships in-process; no sidecar daemon (OPA
  Rego eval is fast but operationally heavier for a self-hosted
  v1 portal). The bundle is ~12 MB which is acceptable for a
  Postgres-anchored backend.
- **Sync API.** `isAuthorized()` is synchronous so we can drop it
  inline in existing controllers without an async refactor.
- **Familiar to the AGO crowd.** AGS sharing rules are imperative
  but the underlying mental model (principal, action, resource,
  conditions) maps cleanly to Cedar; users coming from Esri see
  similar shape, written declaratively.

OPA stays a candidate for the v2 multi-tenant SaaS hosting story
where running a sidecar pays for itself; until then Cedar's
in-process model wins.

## Integration scope

Wiring Cedar in is broken into three phases. Phase A landed
alongside this doc; Phase B and C are follow-ups.

### Phase A (this commit)

- Add `@cedar-policy/cedar-wasm@^4.10.0` to `apps/portal-api`.
- Stand up `PolicyModule` + `PolicyService.check()` in
  `apps/portal-api/src/policy/`. `check()` takes a
  `PolicyCheckRequest` (principal, action, resource, optional
  context, optional entities, optional policy override) and
  returns a `PolicyCheckResult` (decision, reasons, errors).
- Ship `DEFAULT_POLICY_TEXT` covering the four
  static rules `SharingService` enforces today: owner can do
  anything; org admin can do anything inside the org; public
  items are world-readable; org-access items are readable by
  org members. Explicit per-share grants
  (`item_share` rows) stay in `SharingService` for now.
- Add a Jest spec exercising every default policy branch plus a
  caller-supplied policy override (forbid-trumps-permit).
- `PolicyService` is registered in `AppModule` so other modules
  can inject it. **No callsites use it yet.** SharingService
  still owns the runtime authorization decision.

### Phase B (next commit, not yet shipped)

Migrate `SharingService.canRead / canEdit / canDownload / canAdmin`
to delegate to `PolicyService.check`. Keep the existing public
function shape so controllers don't change. Each canX call:

- Builds a `PolicyEntity[]` from the principal (User), the org
  (Org), and the resource (Item).
- Calls `policy.check({...})` with the matching action.
- Returns `result.decision === 'allow'`.

The migration is value-preserving: the default policy text is
designed to produce the same answer as the existing function
body, and the existing ~60 sharing tests stay green throughout
the migration.

Per-share grants (`item_share.permission == 'view' | 'edit' |
'download' | 'admin'`) become entity attributes on the User entity:

```cedar
permit (
  principal,
  action == Action::"read",
  resource
) when {
  resource has shareGrants &&
  resource.shareGrants.contains(principal)
};
```

### Phase C (after dashboards / lens MVP)

Lens-level custom policies. A lens has an optional
`Lens.policy` Cedar text field. At read time, the engine prepends
`DEFAULT_POLICY_TEXT` and appends the lens policy, evaluating the
combined set against the request. This is the surface that
unblocks the geometry-aware demo policies in
`observation-log-engine.md`:

```cedar
permit (
  principal,
  action == Action::"read",
  resource is Lens
) when {
  resource.feature.geom in principal.assignedPolygon
};
```

Geometry-in-polygon needs Cedar set / extension types; the WASM
binding ships an `extensions` block we wire up in Phase C.

## Entity model

The portal's authorization world has three entity types in v1:

- `User::"<userUuid>"` -- one per portal user. Attributes: `org`
  (entity ref to Org), `role` ("admin" | "contributor" | "viewer").
- `Org::"<orgUuid>"` -- one per organisation. No attributes in v1;
  org membership is recorded as the User's `org` attribute.
- `Item::"<itemUuid>"` -- one per portal item. Attributes:
  `owner` (entity ref to User), `org` (entity ref to Org),
  `access` ("private" | "org" | "public").

Phase B adds a `shareGrants: Set<User>` attribute on Item; Phase C
adds `feature` and `lens` typed entities for row- / lens-level
checks. The schema lives in `apps/portal-api/src/policy/schema.ts`
once Phase B lands; v1 evaluates without a schema (Cedar runs in
"unscoped" mode).

## Performance

Cedar's WASM authorize is reported at sub-millisecond for small
policy sets (<10 rules) on small entity stores (<100 entities). For
v1 sharing checks, that's 4 rules, 3 entities. We expect
authorization to remain off the perf hot path; if it isn't, the
likely culprit is the entity store build (one Item lookup per
request) which we cache with the existing item read.

## Operational notes

- The WASM binary is loaded by `PolicyService`'s constructor; a
  startup failure surfaces in the API logs immediately. Production
  health-check probes route through the same module so a broken
  Cedar install won't pass health checks silently.
- Policy authoring UI is post-launch. Lens-level policies in v1
  are JSON-on-disk in the lens detail page (visible only to org
  admins).
- We do not validate policies against a Cedar schema in v1.
  `validate()` is available in the WASM bundle and is the obvious
  place to add a "save policy" guard once we have the schema.

## References

- [Cedar language spec](https://docs.cedarpolicy.com/)
- [@cedar-policy/cedar-wasm npm](https://www.npmjs.com/package/@cedar-policy/cedar-wasm)
- `apps/portal-api/src/policy/policy.service.ts` -- service entry point
- `apps/portal-api/src/policy/policy.service.spec.ts` -- behaviour
  reference for the default policies
