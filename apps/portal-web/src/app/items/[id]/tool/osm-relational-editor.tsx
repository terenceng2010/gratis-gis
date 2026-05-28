// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Visual builder for the OsmRelationalQueryAction shape (#142).
 *
 * The relational action declares an anchor preset, one or more
 * "near A AND near B" conditions, optional negations ("AND NOT
 * near C"), and optional bearings ("with A roughly NW of B").
 * Before this component, the tool detail page just rendered a
 * "JSON edit it for now" note when the user switched the action
 * kind to osm-relational-query; this surface gives authors a
 * proper form so they don't need to hand-craft the JSON.
 *
 * Reuses the OsmPresetMultiSelect component from the recipe
 * editor (constrained to a single preset for the anchor + each
 * condition slot via `firstOnly` semantics).  The AOI parameter
 * stays the defaulted-drawn-polygon that `emptyOsmRelationalQueryAction`
 * mints; advanced authors who want a different AOI parameter
 * can still drop to JSON.
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { OsmRelationalQueryAction } from '@gratis-gis/shared-types';

interface Props {
  action: OsmRelationalQueryAction;
  canEdit: boolean;
  onChange: (next: OsmRelationalQueryAction) => void;
}

const labelCls = 'block text-xs font-medium text-ink-1 mb-1';
const inputCls =
  'w-full rounded-md border border-border bg-surface-0 px-2 py-1.5 text-sm text-ink-0 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30';
const sectionCls =
  'rounded-md border border-border bg-surface-1 p-3 space-y-2';
const sectionHeaderCls =
  'flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted';
const sectionAddBtnCls =
  'inline-flex items-center gap-1 rounded-md border border-dashed border-border bg-surface-2 px-2 py-1 text-[11px] text-ink-1 hover:bg-surface-1 disabled:opacity-50';
const rowRemoveBtnCls =
  'self-start rounded-md border border-border bg-surface-0 px-2 py-1 text-[11px] text-rose-700 hover:bg-rose-50';

type Catalog = Array<{ id: string; label: string; category: string }>;

export function OsmRelationalEditor({ action, canEdit, onChange }: Props) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/portal/public/osm/presets', {
          cache: 'force-cache',
        });
        if (!res.ok) {
          if (!cancelled) setCatalog([]);
          return;
        }
        const body = (await res.json()) as { presets: Catalog };
        if (!cancelled) setCatalog(body.presets ?? []);
      } catch {
        if (!cancelled) setCatalog([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function setAnchor(presetId: string): void {
    onChange({ ...action, anchorPreset: presetId });
  }

  function addCondition(): void {
    onChange({
      ...action,
      conditions: [
        ...action.conditions,
        { preset: '', distance: { value: 0.5, unit: 'mi' } },
      ],
    });
  }
  function setCondition(
    i: number,
    patch: Partial<OsmRelationalQueryAction['conditions'][number]>,
  ): void {
    const next = action.conditions.slice();
    next[i] = { ...next[i]!, ...patch };
    onChange({ ...action, conditions: next });
  }
  function removeCondition(i: number): void {
    onChange({
      ...action,
      conditions: action.conditions.filter((_, j) => j !== i),
      // Drop any bearings that referenced the removed condition or
      // shift their indices down to keep them pointed at the right
      // remaining condition.  Easier to drop than to shift; the
      // user can re-add the bearing if needed.
      ...(action.bearings
        ? {
            bearings: action.bearings
              .filter((b) => b.conditionIndex !== i)
              .map((b) =>
                b.conditionIndex > i
                  ? { ...b, conditionIndex: b.conditionIndex - 1 }
                  : b,
              ),
          }
        : {}),
    });
  }

  function addNegation(): void {
    onChange({
      ...action,
      negations: [
        ...(action.negations ?? []),
        { preset: '', distance: { value: 0.25, unit: 'mi' } },
      ],
    });
  }
  function setNegation(
    i: number,
    patch: Partial<NonNullable<OsmRelationalQueryAction['negations']>[number]>,
  ): void {
    const arr = (action.negations ?? []).slice();
    arr[i] = { ...arr[i]!, ...patch };
    onChange({ ...action, negations: arr });
  }
  function removeNegation(i: number): void {
    const arr = (action.negations ?? []).filter((_, j) => j !== i);
    if (arr.length === 0) {
      // Drop the empty array entirely so the action's JSON stays clean.
      const next = { ...action };
      delete (next as { negations?: unknown }).negations;
      onChange(next);
      return;
    }
    onChange({ ...action, negations: arr });
  }

  function addBearing(): void {
    onChange({
      ...action,
      bearings: [
        ...(action.bearings ?? []),
        { conditionIndex: 0, bearingDegrees: 0, toleranceDegrees: 30 },
      ],
    });
  }
  function setBearing(
    i: number,
    patch: Partial<NonNullable<OsmRelationalQueryAction['bearings']>[number]>,
  ): void {
    const arr = (action.bearings ?? []).slice();
    arr[i] = { ...arr[i]!, ...patch };
    onChange({ ...action, bearings: arr });
  }
  function removeBearing(i: number): void {
    const arr = (action.bearings ?? []).filter((_, j) => j !== i);
    if (arr.length === 0) {
      const next = { ...action };
      delete (next as { bearings?: unknown }).bearings;
      onChange(next);
      return;
    }
    onChange({ ...action, bearings: arr });
  }

  return (
    <div className="space-y-4">
      <div className={sectionCls}>
        <div className={sectionHeaderCls}>
          <span>Anchor</span>
        </div>
        <p className="text-[11px] text-muted">
          The feature kind you&apos;re trying to find. Every surviving
          result will be one of these.
        </p>
        <PresetPickerSingle
          value={action.anchorPreset}
          catalog={catalog}
          canEdit={canEdit}
          onChange={setAnchor}
          placeholder="Search OSM presets, e.g. school, gas station..."
        />
      </div>

      <div className={sectionCls}>
        <div className={sectionHeaderCls}>
          <span>Conditions (AND)</span>
          <button
            type="button"
            disabled={!canEdit}
            onClick={addCondition}
            className={sectionAddBtnCls}
          >
            <Plus className="h-3 w-3" /> Add condition
          </button>
        </div>
        <p className="text-[11px] text-muted">
          The anchor must have AT LEAST ONE feature of every condition
          within the specified distance to survive.
        </p>
        {action.conditions.length === 0 ? (
          <p className="text-[11px] italic text-muted">
            No conditions yet. Add one to define what the anchor must
            be near.
          </p>
        ) : (
          <div className="space-y-2">
            {action.conditions.map((c, i) => (
              <div
                key={i}
                className="flex items-start gap-2 rounded-md border border-border bg-surface-0 p-2"
              >
                <div className="flex-1 space-y-1.5">
                  <PresetPickerSingle
                    value={c.preset}
                    catalog={catalog}
                    canEdit={canEdit}
                    onChange={(presetId) => setCondition(i, { preset: presetId })}
                    placeholder="Condition preset"
                  />
                  <DistanceRow
                    value={c.distance}
                    canEdit={canEdit}
                    onChange={(distance) => setCondition(i, { distance })}
                  />
                </div>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => removeCondition(i)}
                    aria-label="Remove condition"
                    className={rowRemoveBtnCls}
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={sectionCls}>
        <div className={sectionHeaderCls}>
          <span>Negations (AND NOT)</span>
          <button
            type="button"
            disabled={!canEdit}
            onClick={addNegation}
            className={sectionAddBtnCls}
          >
            <Plus className="h-3 w-3" /> Add negation
          </button>
        </div>
        <p className="text-[11px] text-muted">
          Drop anchors that have any feature of these presets within
          the specified distance. Useful for &quot;school near park
          but NOT near a highway.&quot;
        </p>
        {(action.negations?.length ?? 0) === 0 ? (
          <p className="text-[11px] italic text-muted">
            No negations. Optional.
          </p>
        ) : (
          <div className="space-y-2">
            {(action.negations ?? []).map((n, i) => (
              <div
                key={i}
                className="flex items-start gap-2 rounded-md border border-border bg-surface-0 p-2"
              >
                <div className="flex-1 space-y-1.5">
                  <PresetPickerSingle
                    value={n.preset}
                    catalog={catalog}
                    canEdit={canEdit}
                    onChange={(presetId) => setNegation(i, { preset: presetId })}
                    placeholder="Negation preset"
                  />
                  <DistanceRow
                    value={n.distance}
                    canEdit={canEdit}
                    onChange={(distance) => setNegation(i, { distance })}
                  />
                </div>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => removeNegation(i)}
                    aria-label="Remove negation"
                    className={rowRemoveBtnCls}
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={sectionCls}>
        <div className={sectionHeaderCls}>
          <span>Bearings (angular constraints)</span>
          <button
            type="button"
            disabled={!canEdit || action.conditions.length === 0}
            onClick={addBearing}
            className={sectionAddBtnCls}
            title={
              action.conditions.length === 0
                ? 'Add a condition first; bearings reference a condition.'
                : undefined
            }
          >
            <Plus className="h-3 w-3" /> Add bearing
          </button>
        </div>
        <p className="text-[11px] text-muted">
          Optional: require the anchor to lie in a specific compass
          direction from at least one condition feature. 0=N, 90=E,
          180=S, 270=W. Tolerance widens the arc on either side.
        </p>
        {(action.bearings?.length ?? 0) === 0 ? (
          <p className="text-[11px] italic text-muted">
            No bearings. Optional.
          </p>
        ) : (
          <div className="space-y-2">
            {(action.bearings ?? []).map((b, i) => (
              <div
                key={i}
                className="flex items-start gap-2 rounded-md border border-border bg-surface-0 p-2"
              >
                <div className="flex-1 grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-muted">
                      Condition
                    </label>
                    <select
                      disabled={!canEdit}
                      value={b.conditionIndex}
                      onChange={(e) =>
                        setBearing(i, {
                          conditionIndex: Number(e.target.value),
                        })
                      }
                      className={inputCls}
                    >
                      {action.conditions.map((c, ci) => (
                        <option key={ci} value={ci}>
                          {`#${ci + 1}: ${c.preset || '(unset)'}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-muted">
                      Bearing (deg)
                    </label>
                    <input
                      type="number"
                      disabled={!canEdit}
                      min={0}
                      max={359}
                      value={b.bearingDegrees}
                      onChange={(e) =>
                        setBearing(i, {
                          bearingDegrees: Number(e.target.value),
                        })
                      }
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wide text-muted">
                      Tolerance (deg)
                    </label>
                    <input
                      type="number"
                      disabled={!canEdit}
                      min={1}
                      max={180}
                      value={b.toleranceDegrees}
                      onChange={(e) =>
                        setBearing(i, {
                          toleranceDegrees: Number(e.target.value),
                        })
                      }
                      className={inputCls}
                    />
                  </div>
                </div>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => removeBearing(i)}
                    aria-label="Remove bearing"
                    className={rowRemoveBtnCls}
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={sectionCls}>
        <div className={sectionHeaderCls}>
          <span>Area of interest</span>
        </div>
        <p className="text-[11px] text-muted">
          Defaulted to a drawn polygon: the runtime user draws the
          search area when they run the tool. Advanced authors who
          need a different AOI parameter shape (e.g. bound to a
          host-app layer) can edit the action JSON directly.
        </p>
        <p className="text-[11px] font-mono text-muted">
          parameter: <code>{action.aoiParameterRef || '(unset)'}</code>
        </p>
      </div>
    </div>
  );
}

/**
 * Distance value + unit pair used by relational conditions and
 * negations.  Mirrors the runtime distance input but stays
 * editor-side and skips the meters fallback.
 */
function DistanceRow({
  value,
  canEdit,
  onChange,
}: {
  value: { value: number; unit: 'm' | 'km' | 'ft' | 'mi' };
  canEdit: boolean;
  onChange: (next: { value: number; unit: 'm' | 'km' | 'ft' | 'mi' }) => void;
}) {
  return (
    <div className="flex gap-1.5">
      <input
        type="number"
        step="any"
        min={0}
        disabled={!canEdit}
        value={value.value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange({ ...value, value: n });
        }}
        className={`${inputCls} flex-1`}
      />
      <select
        disabled={!canEdit}
        value={value.unit}
        onChange={(e) =>
          onChange({
            ...value,
            unit: e.target.value as 'm' | 'km' | 'ft' | 'mi',
          })
        }
        className={`${inputCls} w-24`}
      >
        <option value="m">m</option>
        <option value="km">km</option>
        <option value="ft">ft</option>
        <option value="mi">mi</option>
      </select>
    </div>
  );
}

/**
 * Single-preset picker driven by the same iD catalog the multi-
 * select uses, but constrained to one chip.  Type to search;
 * picking a match replaces whatever was set.  Empty string means
 * "no preset chosen yet" (the action's save-time validator can
 * flag that).
 */
function PresetPickerSingle({
  value,
  catalog,
  canEdit,
  onChange,
  placeholder,
}: {
  value: string;
  catalog: Catalog | null;
  canEdit: boolean;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    if (!catalog || query.trim().length < 2) return [];
    const q = query.trim().toLowerCase();
    const hits: Catalog = [];
    for (const p of catalog) {
      if (p.id === value) continue;
      if (
        p.label.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
      ) {
        hits.push(p);
        if (hits.length >= 12) break;
      }
    }
    return hits;
  }, [catalog, query, value]);

  const currentLabel = catalog?.find((p) => p.id === value)?.label ?? value;

  return (
    <div className="space-y-1">
      {value ? (
        <div className="flex items-center gap-1">
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-0 px-2 py-0.5 text-[11px]">
            {currentLabel}
            {canEdit ? (
              <button
                type="button"
                onClick={() => onChange('')}
                aria-label="Clear preset"
                className="text-muted hover:text-rose-700"
              >
                ×
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
      {canEdit && !value ? (
        <>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            className={inputCls}
          />
          {matches.length > 0 ? (
            <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-surface-0">
              {matches.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onChange(p.id);
                    setQuery('');
                  }}
                  className="block w-full px-2 py-1 text-left text-xs hover:bg-surface-1"
                >
                  <span className="text-ink-0">{p.label}</span>
                  <span className="ml-1 text-[10px] text-muted">{p.id}</span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
