// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Runtime parameter UI for tool recipes (#90).
 *
 * When a Button widget is bound to a tool whose action is a
 * `recipe`, clicking the button opens this panel.  The panel
 * resolves every recipe parameter into a concrete value, fires
 * `POST /api/tools/:id/run`, and applies the output (today: a
 * selection update on the host map(s)) before closing.
 *
 * v1 input shapes per parameter kind:
 *   - feature-source / runtime-host:      layer picker from the
 *                                         host app's available
 *                                         layers
 *   - feature-source / runtime-draw:      "Use current map view"
 *                                         shortcut (rectangle of
 *                                         the bound map's bbox)
 *                                         plus inline GeoJSON
 *                                         paste as an escape
 *                                         hatch.  Full drawing UI
 *                                         lands once the runtime
 *                                         grows a freehand draw
 *                                         tool.
 *   - feature-source / runtime-selection: layer picker; uses the
 *                                         currently-selected
 *                                         feature ids on that
 *                                         layer.
 *   - predicate / runtime-pick:           chip strip constrained
 *                                         to the parameter's
 *                                         allowed set
 *   - distance / runtime-input:           number field (meters)
 *   - number  / runtime-input:            number field
 *   - text    / runtime-input:            text field
 *
 * Hardcoded parameters and runtime-* params with defaults that the
 * user doesn't need to override don't appear in the panel; they
 * carry into the request payload silently.
 */

import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Pencil, X } from 'lucide-react';
import type maplibregl from 'maplibre-gl';
import type {
  DistanceParameter,
  FeatureSourceParameter,
  FeatureSourceValue,
  NumberParameter,
  PredicateParameter,
  RecipeAction,
  SpatialPredicate,
  TextParameter,
  ToolParameter,
} from '@gratis-gis/shared-types';

import {
  MapDrawingOverlay,
  type DrawableGeometryType,
} from './map-drawing-overlay.js';

const PREDICATE_LABELS: Record<SpatialPredicate, string> = {
  intersects: 'Intersects',
  within: 'Within',
  contains: 'Contains',
  touches: 'Touches',
  near: 'Within distance',
};

export interface HostLayerOption {
  /** MapLayer.id inside the runtime's mapData -- used to read
   *  current selection and to apply selection back. */
  mapLayerId: string;
  /** Backing data_layer item id. */
  itemId: string;
  /** Optional sublayer key (v3 multi-layer data_layer items). */
  layerKey?: string;
  /** Display label for the picker. */
  title: string;
  /** Geometry type if known, used to filter the picker. */
  geometryType?: 'point' | 'line' | 'polygon' | 'any';
  /** Currently-selected feature ids on this layer in the host
   *  runtime; populated for runtime-selection mode. */
  selectedIds?: Array<string | number>;
  /** Visible bbox of the map this layer is on, when the recipe
   *  needs "Use current map view" to seed a runtime-draw AOI. */
  mapBbox?: [number, number, number, number];
}

export interface RecipeRunResult {
  output: {
    kind: 'selection';
    layer: { itemId: string; layerKey?: string };
    featureIds: Array<string | number>;
    truncated: boolean;
  };
}

interface Props {
  toolId: string;
  toolTitle: string;
  recipe: RecipeAction;
  hostLayers: HostLayerOption[];
  /** Optional bbox of the host's currently-focused map; supplied
   *  separately from hostLayers so a runtime-draw param without a
   *  matching layer can still grab a bbox. */
  hostBbox?: [number, number, number, number];
  /** Resolver for the host's MapLibre instance the freehand-draw
   *  affordance attaches to.  Returns null when no map is mounted;
   *  the panel falls back to the bbox / paste-GeoJSON path in that
   *  case.  A function (rather than a captured value) so the panel
   *  always grabs the live instance at the moment the user clicks
   *  Draw -- the map may have re-mounted since the panel opened. */
  getDrawMap?: () => maplibregl.Map | null;
  onClose: () => void;
  onResult: (result: RecipeRunResult) => void;
}

export function RecipeRunPanel({
  toolId,
  toolTitle,
  recipe,
  hostLayers,
  hostBbox,
  getDrawMap,
  onClose,
  onResult,
}: Props) {
  // Visible parameter list: the ones the user needs to touch.
  // Hardcoded params and defaults-with-no-override-needed roll
  // straight into the request without a UI row.
  const visibleParams = useMemo(
    () => recipe.parameters.filter(isInteractiveParam),
    [recipe.parameters],
  );

  // Per-parameter staged value.  Keyed by parameter name.  Each
  // value is the same shape the API expects in `parameters[name]`.
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    seedValues(recipe.parameters, hostLayers, hostBbox),
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // When non-null, the panel collapses to a thin banner and lets
  // the user click on the host map to draw an AOI for the named
  // parameter.  The `mapInstance` is captured up front (at the
  // moment the user hits the Draw button) so React state churn
  // doesn't cause the drawing overlay to re-mount mid-interaction.
  const [drawing, setDrawing] = useState<{
    paramName: string;
    geometryType: DrawableGeometryType;
    mapInstance: maplibregl.Map;
  } | null>(null);

  function patch(name: string, next: unknown) {
    setValues((v) => ({ ...v, [name]: next }));
  }

  /** Called by FeatureSourceInput when the user clicks "Draw on
   *  map" for a runtime-draw parameter.  Falls back silently if no
   *  map is available -- the input keeps its bbox + paste-GeoJSON
   *  affordances as the recovery path. */
  function startDrawing(paramName: string, geometryType: DrawableGeometryType) {
    const m = getDrawMap?.();
    if (!m) return;
    setDrawing({ paramName, geometryType, mapInstance: m });
  }

  function finishDrawing(geometry: GeoJSON.Geometry) {
    if (!drawing) return;
    patch(drawing.paramName, { kind: 'inline-geojson', geojson: geometry });
    setDrawing(null);
  }
  function cancelDrawing() {
    setDrawing(null);
  }

  async function run(): Promise<void> {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/portal/tools/${toolId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parameters: values }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { message?: string };
          if (body.message) msg = body.message;
        } catch {
          /* fall through */
        }
        throw new Error(msg);
      }
      const body = (await res.json()) as RecipeRunResult;
      onResult(body);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  // When drawing, the modal collapses to a thin top banner so the
  // user can see and click the map.  The dim-overlay backdrop also
  // drops away so canvas events can reach the map.  Cancel + a
  // "what to do" hint stay visible in the banner; finishing the
  // draw flips us back to the full modal with the AOI captured.
  if (drawing) {
    const drawBanner = (
      <>
        <MapDrawingOverlay
          map={drawing.mapInstance}
          geometryType={drawing.geometryType}
          onComplete={finishDrawing}
          onCancel={cancelDrawing}
        />
        <div
          className="pointer-events-none fixed inset-x-0 top-4 z-[1000] flex justify-center"
          aria-live="polite"
        >
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-surface-0/95 px-4 py-2 text-xs shadow-raised backdrop-blur">
            <Pencil className="h-3.5 w-3.5 text-accent" />
            <span className="text-ink-0">
              {drawing.geometryType === 'point'
                ? 'Click on the map to drop a point.'
                : drawing.geometryType === 'line'
                  ? 'Click to add vertices; double-click to finish the line.'
                  : 'Click to add vertices; double-click to close the polygon.'}
            </span>
            <button
              type="button"
              onClick={cancelDrawing}
              className="rounded-md border border-border bg-surface-1 px-2 py-0.5 text-[11px] text-ink-1 hover:bg-surface-2"
            >
              Cancel
            </button>
          </div>
        </div>
      </>
    );
    return createPortal(drawBanner, document.body);
  }

  const modal = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="recipe-run-title"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 px-4 py-8"
      onClick={(e) => {
        // Click outside closes; click inside doesn't bubble.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-surface-0 p-4 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="recipe-run-title" className="text-sm font-medium text-ink-0">
              {toolTitle}
            </h2>
            <p className="text-[11px] text-muted">
              Fill in the inputs below, then click Run.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-surface-1 p-1 text-muted hover:text-ink-1"
            title="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="space-y-3">
          {visibleParams.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-surface-2 px-3 py-3 text-[11px] text-muted">
              This tool has no runtime inputs.  Click Run to execute.
            </p>
          ) : (
            visibleParams.map((p) => (
              <ParamInputRow
                key={p.name}
                parameter={p}
                value={values[p.name]}
                onChange={(v) => patch(p.name, v)}
                hostLayers={hostLayers}
                {...(hostBbox ? { hostBbox } : {})}
                {...(getDrawMap ? { onStartDraw: startDrawing } : {})}
              />
            ))
          )}
        </div>

        {error ? (
          <div className="mt-3 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-[11px] text-rose-900">
            {error}
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs text-ink-1 hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void run()}
            disabled={running}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Run
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

// ---- Per-parameter input rows --------------------------------------------

function ParamInputRow({
  parameter,
  value,
  onChange,
  hostLayers,
  hostBbox,
  onStartDraw,
}: {
  parameter: ToolParameter;
  value: unknown;
  onChange: (next: unknown) => void;
  hostLayers: HostLayerOption[];
  hostBbox?: [number, number, number, number];
  onStartDraw?: (paramName: string, geometryType: DrawableGeometryType) => void;
}) {
  switch (parameter.kind) {
    case 'feature-source':
      return (
        <FeatureSourceInput
          parameter={parameter}
          value={value as FeatureSourceValue | undefined}
          onChange={onChange}
          hostLayers={hostLayers}
          {...(hostBbox ? { hostBbox } : {})}
          {...(onStartDraw ? { onStartDraw } : {})}
        />
      );
    case 'predicate':
      return (
        <PredicateInput
          parameter={parameter}
          value={value as SpatialPredicate | undefined}
          onChange={onChange}
        />
      );
    case 'distance':
      return (
        <DistanceInput
          parameter={parameter}
          value={value as number | undefined}
          onChange={onChange}
        />
      );
    case 'number':
      return (
        <NumberInput
          parameter={parameter}
          value={value as number | undefined}
          onChange={onChange}
        />
      );
    case 'text':
      return (
        <TextInput
          parameter={parameter}
          value={value as string | undefined}
          onChange={onChange}
        />
      );
  }
}

function FeatureSourceInput({
  parameter,
  value,
  onChange,
  hostLayers,
  hostBbox,
  onStartDraw,
}: {
  parameter: FeatureSourceParameter;
  value: FeatureSourceValue | undefined;
  onChange: (next: FeatureSourceValue) => void;
  hostLayers: HostLayerOption[];
  hostBbox?: [number, number, number, number];
  onStartDraw?: (paramName: string, geometryType: DrawableGeometryType) => void;
}) {
  const mode = parameter.binding.mode;
  // Filter host layers to the parameter's geometry type if specified.
  const compatible = hostLayers.filter((h) => {
    const gt = parameter.geometryType ?? 'any';
    if (gt === 'any' || !h.geometryType || h.geometryType === 'any') return true;
    return h.geometryType === gt;
  });

  if (mode === 'runtime-host') {
    const current = value?.kind === 'data_layer' ? value : undefined;
    return (
      <div className="space-y-1">
        <Label parameter={parameter} />
        <select
          value={current ? `${current.itemId}::${current.layerKey ?? ''}` : ''}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            const [itemId, layerKey] = v.split('::');
            onChange({
              kind: 'data_layer',
              itemId: itemId!,
              ...(layerKey ? { layerKey } : {}),
            });
          }}
          className={inputCls}
        >
          <option value="">(pick a layer)</option>
          {compatible.map((h) => (
            <option key={h.mapLayerId} value={`${h.itemId}::${h.layerKey ?? ''}`}>
              {h.title}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (mode === 'runtime-draw') {
    const inlineGeo = value?.kind === 'inline-geojson' ? value.geojson : undefined;
    function useBboxAsRectangle() {
      const bbox = hostBbox ?? hostLayers[0]?.mapBbox;
      if (!bbox) return;
      const [w, s, e, n] = bbox;
      const polygon: GeoJSON.Polygon = {
        type: 'Polygon',
        coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
      };
      onChange({ kind: 'inline-geojson', geojson: polygon });
    }
    // Translate the parameter's declared geometry type into the
    // narrower set the drawing overlay understands.  'any' falls
    // back to polygon because that's the most common AOI shape and
    // both line + point AOIs are degenerate cases for almost every
    // spatial-filter predicate.
    const drawGeometryType: DrawableGeometryType =
      parameter.geometryType === 'point'
        ? 'point'
        : parameter.geometryType === 'line'
          ? 'line'
          : 'polygon';
    return (
      <div className="space-y-2">
        <Label parameter={parameter} />
        <p className="text-[11px] text-muted">
          Draw an area on the map, snap the current view as a
          rectangle, or paste GeoJSON.
        </p>
        <div className="flex flex-wrap gap-2">
          {onStartDraw ? (
            <button
              type="button"
              onClick={() => onStartDraw(parameter.name, drawGeometryType)}
              className="inline-flex items-center gap-1 rounded-md border border-accent bg-accent/5 px-2 py-1 text-[11px] text-ink-0 hover:bg-accent/10"
            >
              <Pencil className="h-3 w-3 text-accent" />
              Draw on map
            </button>
          ) : null}
          <button
            type="button"
            onClick={useBboxAsRectangle}
            disabled={!hostBbox && !hostLayers[0]?.mapBbox}
            className="rounded-md border border-border bg-surface-1 px-2 py-1 text-[11px] hover:bg-surface-2 disabled:opacity-50"
          >
            Use current map view
          </button>
          {inlineGeo ? (
            <span className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-900">
              AOI set
            </span>
          ) : null}
        </div>
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted">
            Paste GeoJSON (advanced)
          </summary>
          <textarea
            value={inlineGeo ? JSON.stringify(inlineGeo) : ''}
            onChange={(e) => {
              const raw = e.target.value.trim();
              if (!raw) return;
              try {
                const parsed = JSON.parse(raw);
                onChange({ kind: 'inline-geojson', geojson: parsed });
              } catch {
                /* keep the textarea editable; the runner will reject
                   invalid JSON when Run is clicked. */
              }
            }}
            rows={4}
            placeholder='{"type":"Polygon","coordinates":[[[...]]]}'
            className="mt-1 w-full rounded-md border border-border bg-surface-0 px-2 py-1.5 font-mono text-[10px]"
          />
        </details>
      </div>
    );
  }

  if (mode === 'runtime-selection') {
    const current =
      value?.kind === 'data_layer' && value.featureIds && value.featureIds.length > 0
        ? value
        : undefined;
    // Only show layers with a non-empty selection.  If none do, the
    // user can pick a layer but the recipe will fail at run time.
    const eligible = compatible.filter((h) => (h.selectedIds?.length ?? 0) > 0);
    const pool = eligible.length > 0 ? eligible : compatible;
    return (
      <div className="space-y-1">
        <Label parameter={parameter} />
        <p className="text-[11px] text-muted">
          Uses the current selection on the chosen layer.
        </p>
        <select
          value={current ? `${current.itemId}::${current.layerKey ?? ''}` : ''}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            const [itemId, layerKey] = v.split('::');
            const host = pool.find(
              (h) => h.itemId === itemId && (h.layerKey ?? '') === (layerKey ?? ''),
            );
            const selectedIds = host?.selectedIds ?? [];
            onChange({
              kind: 'data_layer',
              itemId: itemId!,
              ...(layerKey ? { layerKey } : {}),
              featureIds: selectedIds,
            });
          }}
          className={inputCls}
        >
          <option value="">(pick a layer)</option>
          {pool.map((h) => (
            <option key={h.mapLayerId} value={`${h.itemId}::${h.layerKey ?? ''}`}>
              {h.title} ({h.selectedIds?.length ?? 0} selected)
            </option>
          ))}
        </select>
      </div>
    );
  }

  // Hardcoded: nothing to ask, but show what the tool will use.
  return null;
}

function PredicateInput({
  parameter,
  value,
  onChange,
}: {
  parameter: PredicateParameter;
  value: SpatialPredicate | undefined;
  onChange: (next: SpatialPredicate) => void;
}) {
  if (parameter.binding.mode !== 'runtime-pick') return null;
  const allowed = parameter.binding.allowed ?? [
    'intersects',
    'within',
    'contains',
    'touches',
    'near',
  ];
  const current = value ?? parameter.binding.defaultValue;
  return (
    <div className="space-y-1">
      <Label parameter={parameter} />
      <select
        value={current}
        onChange={(e) => onChange(e.target.value as SpatialPredicate)}
        className={inputCls}
      >
        {allowed.map((p) => (
          <option key={p} value={p}>
            {PREDICATE_LABELS[p]}
          </option>
        ))}
      </select>
    </div>
  );
}

function DistanceInput({
  parameter,
  value,
  onChange,
}: {
  parameter: DistanceParameter;
  value: number | undefined;
  onChange: (next: number) => void;
}) {
  if (parameter.binding.mode !== 'runtime-input') return null;
  const current = value ?? parameter.binding.defaultMeters;
  return (
    <div className="space-y-1">
      <Label parameter={parameter} />
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={parameter.binding.minMeters ?? 0}
          {...(parameter.binding.maxMeters !== undefined
            ? { max: parameter.binding.maxMeters }
            : {})}
          value={current}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
          className={`${inputCls} flex-1`}
        />
        <span className="text-[11px] text-muted">meters</span>
      </div>
    </div>
  );
}

function NumberInput({
  parameter,
  value,
  onChange,
}: {
  parameter: NumberParameter;
  value: number | undefined;
  onChange: (next: number) => void;
}) {
  if (parameter.binding.mode !== 'runtime-input') return null;
  const current = value ?? parameter.binding.defaultValue;
  return (
    <div className="space-y-1">
      <Label parameter={parameter} />
      <input
        type="number"
        {...(parameter.binding.min !== undefined ? { min: parameter.binding.min } : {})}
        {...(parameter.binding.max !== undefined ? { max: parameter.binding.max } : {})}
        value={current}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className={inputCls}
      />
    </div>
  );
}

function TextInput({
  parameter,
  value,
  onChange,
}: {
  parameter: TextParameter;
  value: string | undefined;
  onChange: (next: string) => void;
}) {
  if (parameter.binding.mode !== 'runtime-input') return null;
  const current = value ?? parameter.binding.defaultValue ?? '';
  return (
    <div className="space-y-1">
      <Label parameter={parameter} />
      <input
        type="text"
        value={current}
        onChange={(e) => onChange(e.target.value)}
        className={inputCls}
      />
    </div>
  );
}

function Label({ parameter }: { parameter: ToolParameter }) {
  return (
    <label className="block text-[11px] font-medium text-ink-1">
      {parameter.label}
      {parameter.required ? <span className="text-rose-700"> *</span> : null}
      {parameter.hint ? (
        <span className="block text-[10px] font-normal text-muted">
          {parameter.hint}
        </span>
      ) : null}
    </label>
  );
}

const inputCls =
  'w-full rounded-md border border-border bg-surface-0 px-2 py-1.5 text-sm text-ink-0 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30';

// ---- Helpers --------------------------------------------------------------

/**
 * True when this parameter needs a UI row in the runtime panel.
 * Hardcoded parameters are silent (the runtime sends nothing for them
 * and the backend uses the saved value).  Runtime-host params with a
 * pre-bound default that the host has already filled in are silent
 * too -- the panel seeds them and the user only edits if they want.
 */
function isInteractiveParam(p: ToolParameter): boolean {
  switch (p.kind) {
    case 'feature-source':
      return (
        p.binding.mode === 'runtime-host' ||
        p.binding.mode === 'runtime-draw' ||
        p.binding.mode === 'runtime-selection'
      );
    case 'predicate':
      return p.binding.mode === 'runtime-pick';
    case 'distance':
    case 'number':
    case 'text':
      return p.binding.mode === 'runtime-input';
  }
}

/**
 * Pre-fill values for parameters that have sensible runtime defaults
 * (the predicate's default, the distance's default meters, the
 * host's first matching layer).  The user can still override
 * anything; this just keeps a blank Run from failing on a required
 * parameter the runtime could have auto-resolved.
 */
function seedValues(
  parameters: ToolParameter[],
  hostLayers: HostLayerOption[],
  hostBbox?: [number, number, number, number],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of parameters) {
    if (p.kind === 'feature-source') {
      if (p.binding.mode === 'runtime-host') {
        const compatible = hostLayers.filter((h) => {
          const gt = p.geometryType ?? 'any';
          if (gt === 'any' || !h.geometryType || h.geometryType === 'any') return true;
          return h.geometryType === gt;
        });
        if (p.binding.defaultValue) out[p.name] = p.binding.defaultValue;
        else if (compatible[0]) {
          out[p.name] = {
            kind: 'data_layer',
            itemId: compatible[0].itemId,
            ...(compatible[0].layerKey ? { layerKey: compatible[0].layerKey } : {}),
          };
        }
      }
      // runtime-draw: leave empty; the user must explicitly seed via
      // "Use current map view" or pasting GeoJSON.  Don't auto-fill
      // the bbox because that would silently treat "I clicked Run
      // without setting an AOI" as "select everything in the view".
      if (p.binding.mode === 'runtime-selection') {
        // Pick the first layer with a non-empty selection so the Run
        // button is wired to something useful by default.
        const eligible = hostLayers.filter((h) => (h.selectedIds?.length ?? 0) > 0);
        const pick = eligible[0];
        if (pick) {
          out[p.name] = {
            kind: 'data_layer',
            itemId: pick.itemId,
            ...(pick.layerKey ? { layerKey: pick.layerKey } : {}),
            featureIds: pick.selectedIds ?? [],
          };
        }
      }
    } else if (p.kind === 'predicate') {
      if (p.binding.mode === 'runtime-pick') out[p.name] = p.binding.defaultValue;
    } else if (p.kind === 'distance') {
      if (p.binding.mode === 'runtime-input') out[p.name] = p.binding.defaultMeters;
    } else if (p.kind === 'number') {
      if (p.binding.mode === 'runtime-input') out[p.name] = p.binding.defaultValue;
    } else if (p.kind === 'text') {
      if (p.binding.mode === 'runtime-input' && p.binding.defaultValue !== undefined)
        out[p.name] = p.binding.defaultValue;
    }
  }
  // Avoid the unused-var warning when hostBbox is supplied but no
  // parameter consumes it (every consumer reads it from the panel,
  // not from seed values, so this is intentional).
  void hostBbox;
  return out;
}
