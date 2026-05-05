# Forms - data_layer schema mutation API

Design reference for #281, slice b. This is the load-bearing piece of
the form / data_collection consolidation: get this wrong and every
form-edit thereafter is risky. Lock the verb set + compatibility
classes here before writing the implementation.

## Why this exists

Two locked decisions from #281 framed this:

1. Every form materializes a paired data_layer at form-create time.
   The data_layer is the durable home for submissions; the form
   schema is a versioned overlay. (The form-versioning principle
   from `editing-and-collection.md` is preserved verbatim.)
2. Form authors can freely add, rename, restructure, and delete
   questions from the designer. The schema mutation API is what
   translates those edits into safe, durable data_layer changes.

The mutation API exists because raw `ALTER TABLE` is the wrong
boundary: it lets a careless rename silently lose every captured
response, and there's no place to hang the
form-version-to-column-mapping that lets older form versions stay
submittable. We need a structured surface that knows about form
versions, can pre-check feasibility, and refuses the destructive
case until the user has explicitly chosen.

## Compatibility classes

Every mutation falls into one of three classes. The class determines
who can run it and what the system does before applying.

### Always-safe

Adding optional capacity. Existing data is untouched; older form
versions remain submittable; the data_layer schema strictly grows.

- `addColumn` (nullable): a new question was added to the form
- `widenColumn`: varchar(50) -> varchar(255), int -> bigint, etc.
- `dropRequired`: relax a NOT NULL to nullable
- `addPickListValue`: append to a pick list (existing rows unaffected)
- `reorderColumns`: cosmetic, affects the attribute table layout but
  not storage
- `relabelColumn`: change the display label only (column name in the
  table is unchanged; mapping records the mapping)
- `addChildLayer`: a new repeating section in the form materializes a
  related child table

These auto-apply on form save with no review. The form version is
bumped; old form versions still resolve cleanly because the new
column is nullable.

### Constrained

Tightening a constraint where existing data may violate it. The pre-
check is what makes this class non-destructive: we identify the
conflicting rows and present them to the user before the mutation
runs.

- `narrowColumn`: varchar(255) -> varchar(50). Pre-check counts rows
  where the existing value is longer than the new cap.
- `requireColumn`: nullable -> NOT NULL. Pre-check counts NULL rows.
- `addUniqueConstraint`: pre-check counts duplicate values.
- `addCheckConstraint`: pre-check counts violators.

Pre-check returns one of three results:
1. No violations: apply automatically, same path as always-safe.
2. Violations exist: surface the offending row count and a sample;
   the user picks `cancel` (default), `force-truncate-or-null`, or
   `fix-data-first` (cancels the mutation and opens the attribute
   table filtered to violators).
3. Pre-check infeasible (e.g., row count exceeds threshold): force
   the user to `fix-data-first`; we won't materialize a bulk update
   path for arbitrary-size tables.

### Breaking

A change that would orphan or destroy existing data. The user must
explicitly pick a path. Never automatic. The default UI selection is
`cancel`.

- `renameColumn`: data is preserved by renaming the column at the
  database level; the form-to-column mapping is updated for the new
  form version. Older form versions still submit because their
  `formVersionId` carries the old column name and the mapping table
  resolves it.
- `changeColumnType`: requires a transformation function (text -> int
  with a parser, etc). Pre-check applies the transform as a SELECT
  to count rows that would fail the cast. Apply path: ALTER TABLE
  with USING clause; pre-fail rows lose the value (set to NULL or
  the chosen default).
- `dropColumn`: hard data loss. The mutation moves the column to a
  `__deleted_columns` JSONB column on the row instead of issuing
  DROP COLUMN, so submissions captured against the old form version
  still resolve their dropped fields without errors. After a
  retention window (default 90 days, configurable per-org), a
  housekeeping pass actually drops the column.
- `changeGeometryType`: forks the data_layer. Old data stays on the
  old layer; new data lands on the new one. The data_collection
  item is rewired to the new layer. Both items remain visible to
  admins for read-only access.
- `removeChildLayer`: same soft-delete pattern as `dropColumn`,
  applied to the related table.

User-facing copy for breaking changes is direct: "This change will
remove a column and any responses captured against it. Existing
submissions captured against form version X will keep showing the
old values until <retention date>. Are you sure?"

## Verb signatures

All verbs are typed and live under `apps/portal-api/src/forms-schema/
mutations/`. Each is its own file so the compatibility class is
immediately visible.

```ts
type ColumnRef = { layerKey: string; columnKey: string };

interface BaseMutation {
  /** Form item the mutation is being applied through. The data_layer
   *  id is resolved from the form's bound layer, never passed in
   *  directly: that prevents a form designer from mutating a layer
   *  it doesn't own. */
  formId: string;
  /** Form version that authored the mutation. Stamped onto the
   *  data_layer schema history row for audit. */
  fromFormVersion: number;
  /** New form version the mutation produces. Server validates
   *  exact next-integer increment to prevent races. */
  toFormVersion: number;
}

// Always-safe
type AddColumnMutation = BaseMutation & {
  kind: 'add-column';
  layerKey: string;
  column: {
    key: string;
    type: ColumnType;
    nullable: true;        // always-safe class requires nullable
    defaultValue?: unknown;
    pickListItemId?: string;
  };
};

type WidenColumnMutation = BaseMutation & {
  kind: 'widen-column';
  ref: ColumnRef;
  to: ColumnType;          // server validates `to` is a strict
                           // superset of the current type
};

type AddPickListValueMutation = BaseMutation & {
  kind: 'add-picklist-value';
  pickListItemId: string;
  value: { code: string; label: string };
};

type RelabelColumnMutation = BaseMutation & {
  kind: 'relabel-column';
  ref: ColumnRef;
  newLabel: string;
};

type ReorderColumnsMutation = BaseMutation & {
  kind: 'reorder-columns';
  layerKey: string;
  order: string[];         // column keys, full list
};

type DropRequiredMutation = BaseMutation & {
  kind: 'drop-required';
  ref: ColumnRef;
};

type AddChildLayerMutation = BaseMutation & {
  kind: 'add-child-layer';
  parentLayerKey: string;
  child: { key: string; columns: ColumnSpec[] };
};

// Constrained
type NarrowColumnMutation = BaseMutation & {
  kind: 'narrow-column';
  ref: ColumnRef;
  to: ColumnType;
  resolution: 'cancel' | 'truncate' | 'fix-first';
};

type RequireColumnMutation = BaseMutation & {
  kind: 'require-column';
  ref: ColumnRef;
  resolution: 'cancel' | 'set-default' | 'fix-first';
  defaultValue?: unknown;  // required when resolution = 'set-default'
};

// Breaking
type RenameColumnMutation = BaseMutation & {
  kind: 'rename-column';
  ref: ColumnRef;
  newKey: string;
  newLabel?: string;       // usually accompanies a rename
};

type ChangeColumnTypeMutation = BaseMutation & {
  kind: 'change-column-type';
  ref: ColumnRef;
  to: ColumnType;
  transform: ColumnTransform;  // see transforms section below
  resolution: 'cancel' | 'apply';
};

type DropColumnMutation = BaseMutation & {
  kind: 'drop-column';
  ref: ColumnRef;
  resolution: 'cancel' | 'soft-delete' | 'hard-delete';
  // hard-delete is admin-only; soft is the default
};

type ChangeGeometryTypeMutation = BaseMutation & {
  kind: 'change-geometry-type';
  layerKey: string;
  to: GeometryType;
  resolution: 'cancel' | 'fork';
  // No 'apply-in-place' option: changing geometry type on a populated
  // table is the canonical case where forking is the only safe path.
};
```

## Pre-check API

Each mutation is run through a pre-check before commit. The pre-check
is a separate endpoint so the UI can ask "would this be safe?"
without committing.

```
POST /api/forms/:id/schema/precheck
  body: Mutation
  -> 200 { class: 'safe' | 'constrained' | 'breaking',
           violationCount?: number,
           sample?: unknown[],
           reasons: string[] }
```

The UI calls precheck whenever the user pencils a change in the
form designer; the response drives the inline preview ("This change
is safe / 12 rows would be affected / This is a breaking change,
review required"). The actual commit happens at form save.

```
POST /api/forms/:id/schema/apply
  body: Mutation
  -> 200 { newFormVersion: number,
           appliedAt: string }
```

Apply is transactional: either the data_layer DDL, the form-to-column
mapping update, and the form-version bump all succeed, or none do.

## Form-version-aware submission resolution

The reason this whole API exists in this shape is to keep older form
versions submittable. Concretely:

A field worker captures a submission against form v3 while offline.
The form is edited (v4 published) before they sync. Their queued
submission still has columns named per the v3 schema. The drain step:

1. Reads the submission's `formVersionId = 3`.
2. Looks up the form-to-column mapping snapshot for v3.
3. Resolves each answer to the current column key:
   - Unchanged: passthrough.
   - Renamed: use the rename mapping (oldKey -> newKey).
   - Soft-deleted: stuff into `__deleted_columns` JSONB.
   - Type-changed: apply the column transform from the mutation.
4. Inserts the resolved row into the current data_layer schema.

Submissions captured against future form versions (the field
synchronization race) are rejected with a clear error: "This
submission was captured against form version 5, but the current
form is at version 4. The respondent's app needs to refresh."
That case shouldn't normally happen but the contract guards it.

## Column transforms

For `change-column-type`, the mutation must specify a transform. We
provide a fixed library of safe transforms:

```ts
type ColumnTransform =
  | { kind: 'cast'; sql: string }              // any -> any via PG cast
  | { kind: 'parse-int'; default?: number }    // text -> int with NULL on parse fail
  | { kind: 'parse-float'; default?: number }
  | { kind: 'parse-date'; format?: string; default?: string }
  | { kind: 'enum-to-int'; mapping: Record<string, number> }
  | { kind: 'split-by'; separator: string };   // text -> text[]
```

Custom transforms (arbitrary user SQL) are deliberately not
supported in v1. They open injection holes and we'd rather force the
user to do a rename + add-column + populate-by-script for genuinely
weird cases.

## UI surfaces

Two places this design touches the user:

### Form designer "save" path

When the user clicks Save with pending mutations, the designer:

1. POSTs each pending mutation to `/precheck` in parallel.
2. Renders a review screen grouping mutations by class:
   - Always-safe: collapsed by default, count visible
   - Constrained: expanded, with violation counts and resolution
     pickers per row
   - Breaking: expanded, with prominent warning copy and explicit
     resolution selection
3. On confirm, POSTs `/apply` for each mutation in order.
4. Bumps form version on success; surfaces a per-mutation error
   list on partial failure.

### Submission detail page

When viewing a submission whose `formVersionId < currentVersion`,
the page renders:

- A version badge showing which form version was used.
- Soft-deleted column values (when present in `__deleted_columns`)
  displayed in a "removed in form vN" section, with retention
  expiry shown.

## Authorization

Mutations are gated by item edit permission on the form item. The
schema-mutation surface does not expose data_layer DDL directly; an
operator who has data_layer edit but not form edit cannot run these
mutations through the form path (they have the v3 layer DDL instead).

Org admins additionally see a "force apply" toggle on breaking
changes that skips the resolution prompt. This is for migration
scripts; the toggle is logged.

## Soft-delete + hard-delete

The `__deleted_columns` JSONB column is a stash of values that
existed in old form versions but are no longer in the current
schema. It's populated:
- On `drop-column` with resolution `soft-delete`: existing values
  move from the column to the JSONB before DROP COLUMN runs.
- On `change-column-type` where some rows fail the transform: the
  pre-transform value is stashed.

Retention is per-org, default 90 days. A housekeeping pass walks
`__deleted_columns` entries older than the retention window and
removes them. The housekeeping page surfaces this as
"Form-deleted column data: X rows, oldest from <date>".

## Phase 2 items (deliberately out of scope for now)

- Cross-column atomic refactors (split a `name` column into
  `first_name` + `last_name` in one mutation). Achievable today
  with addColumn + populate-via-script + dropColumn, but a typed
  verb would be cleaner.
- Server-side preview mode that runs the mutation in a transaction
  and rolls back, returning the post-mutation row counts. Useful
  for "would this break my dashboards?" before commit.
- Multi-form deduplication: when two forms point at the same
  data_layer (a v1 use case is one form for field, another for
  desk), mutations from one need to be merged carefully with the
  other. v1 keeps the simple "one form per data_layer" rule.

## Open questions to resolve before coding

1. Does `drop-column` ever need a hard-delete option in v1, or is
   soft-delete + housekeeping always sufficient?
2. When forking on `change-geometry-type`, what happens to the form
   item's bind metadata? Does it follow the new layer (most
   intuitive) or stay with the old (preserves history)? Lean
   toward: form stays bound to the old layer in read-only mode and
   the new fork becomes the active target.
3. Pre-check threshold for "infeasible" violation count: 100k? 1M?
   Likely depends on the table's index density. Phase 1: hard-code
   100k, surface with a clear "do this in batches" message.
