'use client';

import type { WebMapLayerStyle } from '@gratis-gis/shared-types';
import type { GeometryFamily } from './layer-metadata';

interface Props {
  value: WebMapLayerStyle;
  onChange: (next: WebMapLayerStyle) => void;
  /**
   * Which geometry families to surface. Empty (or undefined) means
   * "show everything" — appropriate while metadata is still loading.
   * Once the layer's data is sampled we narrow to only what's present.
   */
  geometryTypes?: Set<GeometryFamily>;
}

/**
 * Simple renderer editor. Shows one section per geometry family that
 * the layer's data actually contains. When the metadata sampler hasn't
 * told us what's in the source yet, we fall back to showing all three
 * so a brand-new layer isn't missing controls — geometry narrowing
 * takes over as soon as the first sample comes back.
 *
 * Deliberately spartan: color + size are 80% of styling decisions.
 * Unique-value / class-break renderers ship as a separate panel.
 */
export function StyleEditor({ value, onChange, geometryTypes }: Props) {
  function patch<K extends keyof WebMapLayerStyle>(
    section: K,
    patch: Partial<WebMapLayerStyle[K]>,
  ) {
    onChange({
      ...value,
      [section]: { ...value[section], ...patch },
    });
  }

  const showAll = !geometryTypes || geometryTypes.size === 0;
  const showPolygon = showAll || geometryTypes.has('polygon');
  const showLine = showAll || geometryTypes.has('line');
  const showPoint = showAll || geometryTypes.has('point');

  return (
    <div className="space-y-4">
      {showPolygon ? (
      <section>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
          Polygons
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <Color
            label="Fill"
            value={value.polygon.fillColor}
            onChange={(c) => patch('polygon', { fillColor: c })}
          />
          <Slider
            label="Fill opacity"
            min={0}
            max={1}
            step={0.05}
            value={value.polygon.fillOpacity}
            onChange={(n) => patch('polygon', { fillOpacity: n })}
          />
          <Color
            label="Outline"
            value={value.polygon.strokeColor}
            onChange={(c) => patch('polygon', { strokeColor: c })}
          />
          <Slider
            label="Outline width"
            min={0}
            max={8}
            step={0.5}
            value={value.polygon.strokeWidth}
            onChange={(n) => patch('polygon', { strokeWidth: n })}
          />
        </div>
      </section>
      ) : null}

      {showLine ? (
      <section>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
          Lines
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <Color
            label="Color"
            value={value.line.color}
            onChange={(c) => patch('line', { color: c })}
          />
          <Slider
            label="Width"
            min={0.5}
            max={12}
            step={0.5}
            value={value.line.width}
            onChange={(n) => patch('line', { width: n })}
          />
        </div>
      </section>
      ) : null}

      {showPoint ? (
      <section>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
          Points
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <Color
            label="Fill"
            value={value.point.color}
            onChange={(c) => patch('point', { color: c })}
          />
          <Slider
            label="Radius"
            min={2}
            max={24}
            step={1}
            value={value.point.radius}
            onChange={(n) => patch('point', { radius: n })}
          />
          <Color
            label="Outline"
            value={value.point.strokeColor}
            onChange={(c) => patch('point', { strokeColor: c })}
          />
          <Slider
            label="Outline width"
            min={0}
            max={6}
            step={0.5}
            value={value.point.strokeWidth}
            onChange={(n) => patch('point', { strokeWidth: n })}
          />
        </div>
      </section>
      ) : null}
    </div>
  );
}

function Color({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-10 cursor-pointer rounded border border-border bg-surface-1 p-0.5"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-xs font-mono focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
        />
      </div>
    </label>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center justify-between text-[10px] text-muted">
        <span>{label}</span>
        <span className="tabular-nums">{value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-accent"
      />
    </label>
  );
}
