'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Circle,
  GripVertical,
  List,
  Minus,
  Paperclip,
  Pencil,
  Plus,
  Spline,
  Square,
  Table2,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type {
  FeatureField,
  FeatureFieldStorage,
  FeatureFieldType,
  FeatureServiceDataV3,
  FeatureServiceLayer,
  FieldDomain,
  LayerGeometryType,
} from '@gratis-gis/shared-types';

/**
 * Inline builder for multi-layer feature services.
 *
 * Produces a `FeatureServiceDataV3` that the /items/new wizard POSTs to
 * /api/items at create time. Each layer is either a spatial layer
 * (point/line/polygon) or an attribute-only "table" used for related
 * records. Tables can declare a parent layer + FK column so the
 * relationship is captured at the same time the schema is.
 *
 * Persistence of the per-layer PostGIS tables is Phase C backend work;
 * for now the v3 blob lands in item.data as-is and the detail page
 * surfaces what's there.
 */
interface Props {
  value: FeatureServiceDataV3;
  onChange: (next: FeatureServiceDataV3) => void;
}

const FIELD_TYPE_OPTIONS: Array<{ value: FeatureFieldType; label: string }> = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes/No' },
  { value: 'date', label: 'Date' },
];

const GEOMETRY_OPTIONS: Array<{
  value: LayerGeometryType;
  label: string;
  Icon: typeof Circle;
  short: string;
}> = [
  { value: 'point', label: 'Point layer', Icon: Circle, short: 'Point' },
  { value: 'line', label: 'Line layer', Icon: Spline, short: 'Line' },
  { value: 'polygon', label: 'Polygon layer', Icon: Square, short: 'Polygon' },
  { value: null, label: 'Table (no geometry)', Icon: Table2, short: 'Table' },
];

function randomId(prefix: string): string {
  // Short opaque ids for layers. Not globally unique, just stable per
  // wizard session — the backend will assign its own uuids when it
  // materializes the tables in Phase C.
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 60) || 'layer'
  );
}

function newLayer(geometryType: LayerGeometryType): FeatureServiceLayer {
  const defaultLabel =
    geometryType === null
      ? 'New table'
      : `New ${geometryType} layer`;
  return {
    id: randomId(geometryType === null ? 'tbl' : 'lyr'),
    label: defaultLabel,
    name: slugify(defaultLabel),
    geometryType,
    fields: [],
    editingEnabled: true,
    attachmentsEnabled: false,
  };
}

function newField(): FeatureField {
  return {
    name: '',
    type: 'string',
    label: '',
    nullable: true,
  };
}

export function FeatureServiceBuilder({ value, onChange }: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const layers = value.layers;

  const spatialLayers = useMemo(
    () => layers.filter((l) => l.geometryType !== null),
    [layers],
  );

  const updateLayers = useCallback(
    (nextLayers: FeatureServiceLayer[]) => {
      onChange({ ...value, layers: nextLayers });
    },
    [onChange, value],
  );

  const addLayer = useCallback(
    (geometryType: LayerGeometryType) => {
      updateLayers([...layers, newLayer(geometryType)]);
      setAddOpen(false);
    },
    [layers, updateLayers],
  );

  const removeLayer = useCallback(
    (id: string) => {
      // Also clean up any layers that pointed at this one as a parent.
      // With exactOptionalPropertyTypes we can't assign `undefined` to an
      // optional prop — build the cleared copy by destructuring instead.
      const next = layers
        .filter((l) => l.id !== id)
        .map((l) => {
          if (l.parentLayerId !== id) return l;
          const { parentLayerId: _p, parentFkColumn: _fk, ...rest } = l;
          void _p;
          void _fk;
          return rest;
        });
      updateLayers(next);
    },
    [layers, updateLayers],
  );

  const patchLayer = useCallback(
    (id: string, patch: Partial<FeatureServiceLayer>) => {
      updateLayers(
        layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
      );
    },
    [layers, updateLayers],
  );

  const replaceLayer = useCallback(
    (id: string, next: FeatureServiceLayer) => {
      // Full replacement — use this (not patchLayer) when you need to
      // *remove* an optional key like parentLayerId, because the spread
      // in patchLayer would merge it back in from the previous state.
      updateLayers(layers.map((l) => (l.id === id ? next : l)));
    },
    [layers, updateLayers],
  );

  return (
    <section className="space-y-3 rounded-lg border border-border bg-surface-1 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink-0">
            Layers &amp; tables
          </h2>
          <p className="text-xs text-muted">
            Add one or more layers (point, line, polygon) and any related
            tables. You can edit schema, toggle editing/attachments, and
            link tables to a parent layer.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setImportOpen((v) => !v)}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 hover:bg-surface-2"
          >
            <Upload className="h-3.5 w-3.5" />
            Import
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setAddOpen((v) => !v)}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-foreground hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" />
              Add layer
              <ChevronDown className="h-3 w-3" />
            </button>
            {addOpen ? (
              <div
                role="menu"
                className="absolute right-0 top-full z-10 mt-1 w-44 overflow-hidden rounded-md border border-border bg-surface-1 shadow-card"
              >
                {GEOMETRY_OPTIONS.map(({ value: gt, label, Icon }) => (
                  <button
                    key={String(gt)}
                    type="button"
                    role="menuitem"
                    onClick={() => addLayer(gt)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink-1 hover:bg-surface-2"
                  >
                    <Icon className="h-3.5 w-3.5 text-muted" />
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {importOpen ? (
        <ImportPanel
          onClose={() => setImportOpen(false)}
          onImport={(imported) => {
            // Append rather than replace — authors can import into an
            // already-seeded builder without losing manually-defined
            // layers.
            updateLayers([...layers, ...imported]);
            setImportOpen(false);
          }}
        />
      ) : null}

      {layers.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-surface-0 p-6 text-center text-xs text-muted">
          No layers yet. Click <span className="font-medium">Add layer</span>{' '}
          above to start, or <span className="font-medium">Import</span> from
          a file.
        </div>
      ) : (
        <ul className="space-y-2">
          {layers.map((layer) => (
            <li key={layer.id}>
              <LayerCard
                layer={layer}
                spatialLayers={spatialLayers}
                onPatch={(patch) => patchLayer(layer.id, patch)}
                onReplace={(next) => replaceLayer(layer.id, next)}
                onRemove={() => removeLayer(layer.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

interface LayerCardProps {
  layer: FeatureServiceLayer;
  /** Layers with a geometry type — potential parents for a table. */
  spatialLayers: FeatureServiceLayer[];
  onPatch: (patch: Partial<FeatureServiceLayer>) => void;
  onReplace: (next: FeatureServiceLayer) => void;
  onRemove: () => void;
}

function LayerCard({
  layer,
  spatialLayers,
  onPatch,
  onReplace,
  onRemove,
}: LayerCardProps) {
  // Default collapsed to keep the page short when several layers exist.
  const [open, setOpen] = useState(true);
  const geom = GEOMETRY_OPTIONS.find((g) => g.value === layer.geometryType);
  const Icon = geom?.Icon ?? Circle;

  const setField = (index: number, patch: Partial<FeatureField>) => {
    const next = layer.fields.map((f, i) => (i === index ? { ...f, ...patch } : f));
    onPatch({ fields: next });
  };
  const addField = () => onPatch({ fields: [...layer.fields, newField()] });
  const removeField = (index: number) =>
    onPatch({ fields: layer.fields.filter((_, i) => i !== index) });

  return (
    <div className="rounded-md border border-border bg-surface-0">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2"
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <span className="flex h-6 w-6 items-center justify-center rounded bg-accent/10 text-accent">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <input
          type="text"
          value={layer.label}
          onChange={(e) => {
            const nextLabel = e.target.value;
            onPatch({
              label: nextLabel,
              // Keep the slugified name in sync only if the user hasn't
              // manually overridden it (i.e. name matches prior slug).
              name:
                layer.name === slugify(layer.label)
                  ? slugify(nextLabel)
                  : layer.name,
            });
          }}
          placeholder={geom?.label ?? 'Layer'}
          className="h-8 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
          {geom?.short ?? 'Layer'}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-danger"
          aria-label="Remove layer"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {open ? (
        <div className="space-y-4 border-t border-border px-3 py-3">
          {/* Machine name — shown as an advanced-ish detail below the display label. */}
          <div className="grid grid-cols-[auto_1fr] items-center gap-2 text-xs">
            <label
              htmlFor={`${layer.id}-name`}
              className="text-muted"
              title="Used in the PostGIS table name and API paths"
            >
              Table name
            </label>
            <input
              id={`${layer.id}-name`}
              type="text"
              value={layer.name}
              onChange={(e) => onPatch({ name: slugify(e.target.value) })}
              placeholder="snake_case"
              className="h-7 w-full rounded border border-border bg-surface-1 px-2 font-mono text-[11px] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>

          <FieldsTable
            fields={layer.fields}
            onFieldChange={setField}
            onFieldRemove={removeField}
            onFieldAdd={addField}
          />

          <div className="flex flex-wrap items-center gap-4 text-xs text-ink-1">
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={layer.editingEnabled}
                onChange={(e) =>
                  onPatch({ editingEnabled: e.target.checked })
                }
                className="h-3.5 w-3.5 rounded border-border"
              />
              <Pencil className="h-3.5 w-3.5 text-muted" />
              Allow editing
            </label>
            <label
              className="inline-flex cursor-pointer items-center gap-1.5"
              title="Attachment storage is a Phase E backend change — the toggle persists so you can opt in now."
            >
              <input
                type="checkbox"
                checked={layer.attachmentsEnabled}
                onChange={(e) =>
                  onPatch({ attachmentsEnabled: e.target.checked })
                }
                className="h-3.5 w-3.5 rounded border-border"
              />
              <Paperclip className="h-3.5 w-3.5 text-muted" />
              Allow attachments
              <span className="text-[10px] text-muted">(storage soon)</span>
            </label>
          </div>

          {layer.geometryType === null ? (
            <ParentLinkRow
              layer={layer}
              spatialLayers={spatialLayers}
              onPatch={onPatch}
              onReplace={onReplace}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface FieldsTableProps {
  fields: FeatureField[];
  onFieldChange: (index: number, patch: Partial<FeatureField>) => void;
  onFieldRemove: (index: number) => void;
  onFieldAdd: () => void;
}

function FieldsTable({
  fields,
  onFieldChange,
  onFieldRemove,
  onFieldAdd,
}: FieldsTableProps) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
          Fields
        </p>
        <button
          type="button"
          onClick={onFieldAdd}
          className="inline-flex h-6 items-center gap-1 rounded border border-border bg-surface-1 px-1.5 text-[11px] text-ink-1 hover:bg-surface-2"
        >
          <Plus className="h-3 w-3" />
          Add field
        </button>
      </div>
      {fields.length === 0 ? (
        <p className="rounded border border-dashed border-border bg-surface-1 px-2 py-3 text-center text-[11px] text-muted">
          No fields yet. Every feature will have a stable id; add fields
          above to store additional attributes.
        </p>
      ) : (
        <div className="overflow-hidden rounded border border-border">
          <table className="w-full text-xs">
            <thead className="bg-surface-2 text-muted">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">
                  <GripVertical className="inline h-3 w-3" />
                </th>
                <th className="px-2 py-1.5 text-left font-medium">Name</th>
                <th className="px-2 py-1.5 text-left font-medium">Type</th>
                <th className="px-2 py-1.5 text-left font-medium">Label</th>
                <th className="px-2 py-1.5 text-center font-medium">Required</th>
                <th className="px-2 py-1.5 text-center font-medium">
                  <span title="Pick list / coded values">Values</span>
                </th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f, i) => (
                <FieldRow
                  key={i}
                  field={f}
                  onChange={(patch) => onFieldChange(i, patch)}
                  onRemove={() => onFieldRemove(i)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface FieldRowProps {
  field: FeatureField;
  onChange: (patch: Partial<FeatureField>) => void;
  onRemove: () => void;
}

/**
 * Single field row. Renders the header inputs (name/type/label/required)
 * and a collapsible pick-list editor below. A field-level "domain" is
 * Esri-terminology for a coded-value constraint; we keep the same model
 * so imports from ArcGIS-land carry over cleanly.
 *
 * Boolean and date fields don't get a pick list (booleans are already
 * binary; dates rarely benefit from a fixed list). The toggle button
 * is disabled in those cases.
 */
function FieldRow({ field, onChange, onRemove }: FieldRowProps) {
  const [expanded, setExpanded] = useState(false);
  const hasDomain =
    field.domain !== undefined && field.domain.type === 'coded-value';
  const canHaveDomain = field.type === 'string' || field.type === 'number';
  // "Advanced" constraints apply to strings (maxLength) and numbers
  // (integer/decimal + precision/scale). Boolean and date get nothing
  // to configure at the storage level.
  const canHaveConstraints = field.type === 'string' || field.type === 'number';
  const hasConstraints = field.storage !== undefined && (
    field.storage.maxLength !== undefined ||
    field.storage.numberKind !== undefined ||
    field.storage.precision !== undefined ||
    field.storage.scale !== undefined
  );
  const anySettings = canHaveDomain || canHaveConstraints;

  function enableDomain() {
    // Seed with a single blank row so the user has something to type into.
    const seed: FieldDomain = {
      type: 'coded-value',
      values: [{ code: field.type === 'number' ? 0 : '', label: '' }],
    };
    onChange({ domain: seed });
    setExpanded(true);
  }

  function disableDomain() {
    // exactOptionalPropertyTypes: drop the key entirely rather than set undefined.
    const { domain: _d, ...rest } = field;
    void _d;
    onChange(rest as Partial<FeatureField>);
    setExpanded(false);
  }

  function patchValues(
    next: Array<{ code: string | number; label: string }>,
  ) {
    if (!field.domain || field.domain.type !== 'coded-value') return;
    onChange({ domain: { type: 'coded-value', values: next } });
  }

  return (
    <>
      <tr className="border-t border-border">
        <td className="px-2 py-1 text-muted">
          <GripVertical className="h-3 w-3" />
        </td>
        <td className="px-1 py-1">
          <input
            type="text"
            value={field.name}
            onChange={(e) => onChange({ name: slugify(e.target.value) })}
            placeholder="field_name"
            className="h-7 w-full rounded border border-border bg-surface-1 px-1.5 font-mono text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          />
        </td>
        <td className="px-1 py-1">
          <select
            value={field.type}
            onChange={(e) => {
              const nextType = e.target.value as FeatureFieldType;
              // If switching to a type that can't hold a domain, drop it
              // rather than leaving stale coded values behind.
              if (
                (nextType === 'boolean' || nextType === 'date') &&
                field.domain
              ) {
                const { domain: _d, ...rest } = field;
                void _d;
                onChange({ ...(rest as Partial<FeatureField>), type: nextType });
              } else {
                onChange({ type: nextType });
              }
            }}
            className="h-7 w-full rounded border border-border bg-surface-1 px-1 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            {FIELD_TYPE_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </td>
        <td className="px-1 py-1">
          <input
            type="text"
            value={field.label}
            onChange={(e) => onChange({ label: e.target.value })}
            placeholder={field.name || 'Display label'}
            className="h-7 w-full rounded border border-border bg-surface-1 px-1.5 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          />
        </td>
        <td className="px-2 py-1 text-center">
          <input
            type="checkbox"
            checked={!field.nullable}
            onChange={(e) => onChange({ nullable: !e.target.checked })}
            className="h-3.5 w-3.5 rounded border-border"
            aria-label="Required"
          />
        </td>
        <td className="px-1 py-1 text-center">
          {/* Generic settings expander: holds the pick-list editor AND
              advanced constraints (maxLength, number kind, precision).
              Active state is shown when the field has either a domain
              or any non-default storage hint so authors can tell at a
              glance which rows carry extra configuration. */}
          {anySettings ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className={`inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[10px] font-medium ${
                hasDomain || hasConstraints
                  ? 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/15'
                  : 'border-border bg-surface-1 text-muted hover:bg-surface-2 hover:text-ink-1'
              }`}
              title={
                hasDomain || hasConstraints
                  ? 'Edit field settings (pick list, constraints)'
                  : 'Add pick list or constraints'
              }
              aria-expanded={expanded}
            >
              {hasDomain ? (
                <>
                  <List className="h-3 w-3" />
                  {(field.domain as { values: unknown[] }).values.length}
                </>
              ) : hasConstraints ? (
                <>
                  <List className="h-3 w-3" />
                  set
                </>
              ) : (
                <>
                  <Plus className="h-3 w-3" />
                  settings
                </>
              )}
            </button>
          ) : (
            <span
              className="text-[10px] text-muted"
              title="Settings apply to text or number fields"
            >
              —
            </span>
          )}
        </td>
        <td className="px-1 py-1">
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-danger"
            aria-label="Remove field"
          >
            <Minus className="h-3 w-3" />
          </button>
        </td>
      </tr>
      {expanded && anySettings ? (
        <tr className="border-t border-border bg-surface-1">
          <td colSpan={7} className="space-y-4 px-3 py-3">
            {canHaveDomain ? (
              hasDomain ? (
                <CodedValueEditor
                  fieldType={field.type}
                  values={
                    (field.domain as {
                      values: Array<{ code: string | number; label: string }>;
                    }).values
                  }
                  onChange={patchValues}
                  onDisable={disableDomain}
                />
              ) : (
                <div className="flex items-center justify-between rounded border border-dashed border-border bg-surface-0 px-3 py-2">
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
                      Pick list
                    </p>
                    <p className="text-[11px] text-muted">
                      Restrict this field to a short, authoritative list
                      of allowed values.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={enableDomain}
                    className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-[11px] font-medium text-ink-1 hover:bg-surface-2"
                  >
                    <Plus className="h-3 w-3" />
                    Add pick list
                  </button>
                </div>
              )
            ) : null}

            {canHaveConstraints ? (
              <ConstraintsEditor field={field} onChange={onChange} />
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------

interface ConstraintsEditorProps {
  field: FeatureField;
  onChange: (patch: Partial<FeatureField>) => void;
}

/**
 * Advanced storage hints for a field. Optional — authors who don't
 * care can ignore them and PostgreSQL's defaults (TEXT, NUMERIC) will
 * carry everything. Shown only for string and number fields since
 * boolean and date have nothing to configure.
 *
 * Under the hood this writes to `field.storage`. When every knob is
 * cleared we remove the whole `storage` object so the saved blob
 * stays tidy.
 */
function ConstraintsEditor({ field, onChange }: ConstraintsEditorProps) {
  const storage = field.storage ?? {};

  // Accept undefined values here explicitly — callers pass `undefined`
  // to mean "clear this key", and exactOptionalPropertyTypes would
  // otherwise reject that on the stricter FeatureFieldStorage shape.
  function patchStorage(
    patch: Partial<Record<keyof FeatureFieldStorage, unknown>>,
  ) {
    const merged: FeatureFieldStorage = { ...storage };
    for (const [k, v] of Object.entries(patch) as Array<
      [keyof FeatureFieldStorage, unknown]
    >) {
      if (
        v === undefined ||
        v === '' ||
        (typeof v === 'number' && Number.isNaN(v))
      ) {
        delete (merged as Record<string, unknown>)[k];
      } else {
        (merged as Record<string, unknown>)[k] = v;
      }
    }
    if (Object.keys(merged).length === 0) {
      const { storage: _s, ...rest } = field;
      void _s;
      onChange(rest as Partial<FeatureField>);
    } else {
      onChange({ storage: merged });
    }
  }

  return (
    <div className="rounded border border-border bg-surface-0 p-3">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
        Constraints
      </p>

      {field.type === 'string' ? (
        <div className="grid grid-cols-[1fr_auto] items-center gap-3 text-xs">
          <label
            htmlFor={`${field.name || 'fld'}-maxlen`}
            className="text-ink-1"
          >
            Max length
            <span className="ml-1 text-[10px] text-muted">
              characters — leave blank for unlimited
            </span>
          </label>
          <input
            id={`${field.name || 'fld'}-maxlen`}
            type="number"
            min={1}
            max={10_000}
            value={storage.maxLength ?? ''}
            onChange={(e) => {
              const raw = e.target.value;
              const n = raw === '' ? undefined : Number(raw);
              patchStorage({ maxLength: n });
            }}
            placeholder="none"
            className="h-7 w-24 rounded border border-border bg-surface-1 px-1.5 text-right font-mono text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          />
        </div>
      ) : null}

      {field.type === 'number' ? (
        <div className="space-y-2 text-xs">
          <div className="grid grid-cols-[1fr_auto] items-center gap-3">
            <label className="text-ink-1">
              Number kind
              <span className="ml-1 text-[10px] text-muted">
                integer = whole numbers only; decimal keeps fractional precision
              </span>
            </label>
            <select
              value={storage.numberKind ?? 'decimal'}
              onChange={(e) =>
                patchStorage({
                  numberKind: e.target.value as 'integer' | 'decimal',
                })
              }
              className="h-7 rounded border border-border bg-surface-1 px-1 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            >
              <option value="decimal">Decimal</option>
              <option value="integer">Integer</option>
            </select>
          </div>
          {(storage.numberKind ?? 'decimal') === 'decimal' ? (
            <>
              <div className="grid grid-cols-[1fr_auto] items-center gap-3">
                <label
                  htmlFor={`${field.name || 'fld'}-prec`}
                  className="text-ink-1"
                >
                  Total digits (precision)
                  <span className="ml-1 text-[10px] text-muted">
                    e.g. 10 for 12345.6789
                  </span>
                </label>
                <input
                  id={`${field.name || 'fld'}-prec`}
                  type="number"
                  min={1}
                  max={38}
                  value={storage.precision ?? ''}
                  onChange={(e) => {
                    const raw = e.target.value;
                    patchStorage({
                      precision: raw === '' ? undefined : Number(raw),
                    });
                  }}
                  placeholder="auto"
                  className="h-7 w-24 rounded border border-border bg-surface-1 px-1.5 text-right font-mono text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                />
              </div>
              <div className="grid grid-cols-[1fr_auto] items-center gap-3">
                <label
                  htmlFor={`${field.name || 'fld'}-scale`}
                  className="text-ink-1"
                >
                  Digits after decimal (scale)
                  <span className="ml-1 text-[10px] text-muted">
                    e.g. 4 for …6789
                  </span>
                </label>
                <input
                  id={`${field.name || 'fld'}-scale`}
                  type="number"
                  min={0}
                  max={38}
                  value={storage.scale ?? ''}
                  onChange={(e) => {
                    const raw = e.target.value;
                    patchStorage({
                      scale: raw === '' ? undefined : Number(raw),
                    });
                  }}
                  placeholder="auto"
                  className="h-7 w-24 rounded border border-border bg-surface-1 px-1.5 text-right font-mono text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                />
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <p className="mt-2 text-[10px] text-muted">
        These are optional. PostgreSQL stores text as unlimited TEXT and
        numbers as arbitrary-precision NUMERIC by default — set these only
        when you need Esri/shapefile export compatibility or strict input
        validation.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface CodedValueEditorProps {
  fieldType: FeatureFieldType;
  values: Array<{ code: string | number; label: string }>;
  onChange: (values: Array<{ code: string | number; label: string }>) => void;
  onDisable: () => void;
}

/**
 * Inline editor for a coded-value domain. Two columns per row (code +
 * label) with an add / delete affordance per row and a "turn off" link
 * that removes the domain from the field entirely.
 */
function CodedValueEditor({
  fieldType,
  values,
  onChange,
  onDisable,
}: CodedValueEditorProps) {
  function patch(index: number, patchObj: Partial<{ code: string | number; label: string }>) {
    const next = values.map((v, i) => (i === index ? { ...v, ...patchObj } : v));
    onChange(next);
  }
  function add() {
    onChange([...values, { code: fieldType === 'number' ? 0 : '', label: '' }]);
  }
  function removeAt(index: number) {
    const next = values.filter((_, i) => i !== index);
    // If the last row was deleted, keep one empty row so the UI stays
    // usable rather than collapsing to a "no values" state that the
    // user then has to re-enable.
    onChange(
      next.length === 0
        ? [{ code: fieldType === 'number' ? 0 : '', label: '' }]
        : next,
    );
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
          Allowed values
        </p>
        <button
          type="button"
          onClick={onDisable}
          className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted hover:bg-surface-2 hover:text-ink-1"
          title="Remove the pick list — any value becomes allowed again"
        >
          <X className="h-3 w-3" />
          Disable pick list
        </button>
      </div>
      <div className="overflow-hidden rounded border border-border">
        <table className="w-full text-xs">
          <thead className="bg-surface-2 text-muted">
            <tr>
              <th className="w-[40%] px-2 py-1 text-left font-medium">
                Code
                <span
                  className="ml-1 text-[9px] uppercase text-muted"
                  title="The stored value"
                >
                  stored
                </span>
              </th>
              <th className="w-[55%] px-2 py-1 text-left font-medium">
                Label
                <span
                  className="ml-1 text-[9px] uppercase text-muted"
                  title="What the user sees"
                >
                  shown
                </span>
              </th>
              <th className="px-1 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {values.map((v, i) => (
              <tr key={i} className="border-t border-border">
                <td className="px-1 py-1">
                  <input
                    type={fieldType === 'number' ? 'number' : 'text'}
                    value={String(v.code)}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const code =
                        fieldType === 'number'
                          ? raw === ''
                            ? 0
                            : Number(raw)
                          : raw;
                      patch(i, { code });
                    }}
                    placeholder={fieldType === 'number' ? '0' : 'code'}
                    className="h-7 w-full rounded border border-border bg-surface-1 px-1.5 font-mono text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    type="text"
                    value={v.label}
                    onChange={(e) => patch(i, { label: e.target.value })}
                    placeholder="Display label"
                    className="h-7 w-full rounded border border-border bg-surface-1 px-1.5 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                  />
                </td>
                <td className="px-1 py-1 text-center">
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-danger"
                    aria-label="Remove value"
                  >
                    <Minus className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-2 inline-flex h-6 items-center gap-1 rounded border border-border bg-surface-1 px-1.5 text-[11px] text-ink-1 hover:bg-surface-2"
      >
        <Plus className="h-3 w-3" />
        Add value
      </button>
      <p className="mt-1 text-[10px] text-muted">
        The code is what&apos;s stored in the database; the label is what
        editors see in the picker.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface ParentLinkProps {
  layer: FeatureServiceLayer;
  spatialLayers: FeatureServiceLayer[];
  onPatch: (patch: Partial<FeatureServiceLayer>) => void;
  onReplace: (next: FeatureServiceLayer) => void;
}

/**
 * Row inside a table-type layer card that lets the user declare this
 * table as a child of one of the spatial layers in the same item. The
 * FK column gets a sensible default based on the parent's slug.
 */
function ParentLinkRow({
  layer,
  spatialLayers,
  onPatch,
  onReplace,
}: ParentLinkProps) {
  const parentOptions = spatialLayers;
  const defaultFkForParent = (parentId: string): string => {
    const p = parentOptions.find((l) => l.id === parentId);
    return p ? `${p.name}_global_id` : 'parent_global_id';
  };

  return (
    <div className="rounded border border-border bg-surface-1 p-2">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
        Related to
      </p>
      <div className="grid grid-cols-[auto_1fr] items-center gap-2 text-xs">
        <label htmlFor={`${layer.id}-parent`} className="text-muted">
          Parent layer
        </label>
        <select
          id={`${layer.id}-parent`}
          value={layer.parentLayerId ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) {
              // Clearing the parent: rebuild the layer without the
              // optional parent/fk props so exactOptionalPropertyTypes
              // stays happy. onReplace (not onPatch) is required here
              // so the omitted keys actually disappear instead of
              // merging back in from the previous layer.
              const {
                parentLayerId: _p,
                parentFkColumn: _fk,
                ...rest
              } = layer;
              void _p;
              void _fk;
              onReplace(rest);
              return;
            }
            // Auto-fill the FK column with a sensible default when the
            // user picks a parent for the first time. If they already
            // edited the column name, respect their value.
            onPatch({
              parentLayerId: v,
              parentFkColumn: layer.parentFkColumn || defaultFkForParent(v),
            });
          }}
          className="h-7 w-full rounded border border-border bg-surface-1 px-1 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
        >
          <option value="">— None (standalone table) —</option>
          {parentOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>

        {layer.parentLayerId ? (
          <>
            <label htmlFor={`${layer.id}-fk`} className="text-muted">
              FK column
            </label>
            <input
              id={`${layer.id}-fk`}
              type="text"
              value={layer.parentFkColumn ?? ''}
              onChange={(e) =>
                onPatch({ parentFkColumn: slugify(e.target.value) })
              }
              placeholder="parent_global_id"
              className="h-7 w-full rounded border border-border bg-surface-1 px-1.5 font-mono text-[11px] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            />
          </>
        ) : null}
      </div>
      {parentOptions.length === 0 ? (
        <p className="mt-1 text-[11px] text-muted">
          Add a spatial layer above first to link this table to.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface ImportPanelProps {
  onClose: () => void;
  onImport: (layers: FeatureServiceLayer[]) => void;
}

/**
 * Stub import panel. GeoJSON gets parsed client-side and turned into a
 * single layer whose schema is derived from the first N features.
 * Shapefile/KML/GDB ingest is Phase D backend work — the UI mentions
 * them so authors know they're coming.
 */
function ImportPanel({ onClose, onImport }: ImportPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);

  async function handleFile(file: File) {
    setError(null);
    setParsing(true);
    try {
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (ext !== 'geojson' && ext !== 'json') {
        setError(
          `Only GeoJSON import works today. ${file.name} looks like ${ext ?? 'something else'} — shapefile/KML/GDB coming soon.`,
        );
        return;
      }
      const text = await file.text();
      const fc = JSON.parse(text);
      if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
        setError('File is not a valid GeoJSON FeatureCollection.');
        return;
      }
      const first = fc.features.find((f: { geometry?: { type?: string } | null }) => f.geometry);
      const geomKind = first?.geometry?.type?.toLowerCase() ?? '';
      const geometryType: LayerGeometryType = geomKind.includes('point')
        ? 'point'
        : geomKind.includes('line')
          ? 'line'
          : geomKind.includes('polygon')
            ? 'polygon'
            : 'point';
      const fields = deriveFieldsFromFeatures(fc.features, 500);
      const layer = newLayer(geometryType);
      layer.label = file.name.replace(/\.(geojson|json)$/i, '');
      layer.name = slugify(layer.label);
      layer.fields = fields;
      layer.featureCount = fc.features.length;
      onImport([layer]);
    } catch (err) {
      setError((err as Error).message || 'Failed to parse file.');
    } finally {
      setParsing(false);
    }
  }

  return (
    <div className="rounded-md border border-border bg-surface-0 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-ink-0">Import from file</p>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-muted hover:text-ink-1"
        >
          Close
        </button>
      </div>
      <label
        htmlFor="fs-builder-import"
        className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded border border-dashed border-border bg-surface-1 px-3 py-4 text-xs text-muted hover:bg-surface-2"
      >
        <Upload className="h-4 w-4" />
        <span>
          Drop a <span className="font-medium">GeoJSON</span> file or click to
          pick one.
        </span>
        <span className="text-[10px]">
          Shapefile, KML/KMZ, and File GDB import coming next.
        </span>
        <input
          id="fs-builder-import"
          type="file"
          accept=".geojson,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            // Allow re-picking the same file.
            e.target.value = '';
          }}
        />
      </label>
      {parsing ? (
        <p className="mt-2 text-[11px] text-muted">Parsing…</p>
      ) : null}
      {error ? (
        <p className="mt-2 text-[11px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Mirror of the deriveFields helper used by the single-layer editor.
 * Kept local so the wizard doesn't need to reach into the [id] route
 * folder (which, as we learned the hard way, confuses webpack).
 */
function deriveFieldsFromFeatures(
  features: Array<{ properties?: Record<string, unknown> | null }>,
  sampleSize: number,
): FeatureField[] {
  const seen = new Map<string, FeatureFieldType>();
  const limit = Math.min(features.length, sampleSize);
  for (let i = 0; i < limit; i++) {
    const props = features[i]?.properties;
    if (!props) continue;
    for (const [k, v] of Object.entries(props)) {
      if (seen.has(k)) continue;
      seen.set(k, inferType(v));
    }
  }
  return Array.from(seen.entries()).map(([name, type]) => ({
    name,
    type,
    label: humanize(name),
    nullable: true,
  }));
}

function inferType(v: unknown): FeatureFieldType {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') {
    // Cheap ISO date sniff.
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return 'date';
    return 'string';
  }
  return 'string';
}

function humanize(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
