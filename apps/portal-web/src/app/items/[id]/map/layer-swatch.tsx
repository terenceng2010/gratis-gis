'use client';

import type { LayerGeometryType, MapLayer } from '@gratis-gis/shared-types';

/**
 * Compact symbology swatch for the per-layer row in LayerPanel and
 * the field-runtime layer list. Mirrors what MapCanvas paints on
 * the map: a circle for points, a stripe for lines, a square for
 * polygons; categorical / class-break renderers get a multi-band
 * stripe so the user can tell "this layer is symbolized by X" at
 * a glance.
 *
 * Originally lived inline in field-runtime; lifted out so the
 * LayerPanel can reuse it without dragging the field-runtime
 * surface in. (#311)
 */
export function LayerSwatch({
  layer,
  dimmed = false,
  geometryType,
}: {
  layer: MapLayer;
  /** When true, drop opacity to ~0.4 so the swatch reads as muted
   *  (matches a hidden / off-scale layer in the panel). */
  dimmed?: boolean;
  /** Underlying geometry of the sublayer the MapLayer points at.
   *  Drives the swatch shape: circle for point, stripe for line,
   *  rounded square for polygon. Falls back to polygon when
   *  null/undefined. */
  geometryType?: LayerGeometryType | null | undefined;
}) {
  const geom = geometryType ?? 'polygon';
  // Pick the primary color for the simple-renderer fallback. Match
  // the geometry: a point swatch should pull from style.point, a
  // polygon from style.polygon, a line from style.line.
  const primary =
    geom === 'point'
      ? layer.style?.point?.color
      : geom === 'line'
        ? layer.style?.line?.color
        : layer.style?.polygon?.fillColor;
  const fallback =
    primary ||
    layer.style?.polygon?.fillColor ||
    layer.style?.point?.color ||
    layer.style?.line?.color ||
    '#6b7280';
  const stroke =
    (geom === 'point'
      ? layer.style?.point?.strokeColor
      : layer.style?.polygon?.strokeColor) ||
    layer.style?.line?.color ||
    '#374151';
  // #264 parity: outline-only polygons (fillOpacity < 0.15) render
  // as hollow squares with a colored border so the swatch matches
  // what the worker paints on the canvas.
  const fillOpacity = layer.style?.polygon?.fillOpacity ?? 1;
  const polygonHollow = geom === 'polygon' && fillOpacity < 0.15;
  const opacity = dimmed ? 0.4 : 1;

  const baseShape =
    geom === 'point'
      ? 'h-3.5 w-3.5 rounded-full'
      : geom === 'line'
        ? 'h-1 w-4 rounded-full'
        : 'h-3.5 w-3.5 rounded-sm';

  const polygonHollowProps = polygonHollow
    ? {
        backgroundColor: 'transparent',
        borderColor: stroke,
        borderWidth: 2,
        opacity,
      }
    : null;

  if (layer.renderer?.kind === 'unique-values') {
    const cats = layer.renderer.categories ?? [];
    const sample = cats.slice(0, 3);
    if (sample.length === 0) {
      return (
        <span
          aria-hidden="true"
          className={`${baseShape} shrink-0 border`}
          style={
            polygonHollowProps ?? {
              backgroundColor: fallback,
              borderColor: stroke,
              opacity,
            }
          }
        />
      );
    }
    return (
      <span
        aria-hidden="true"
        className="flex h-3.5 shrink-0 items-center gap-0.5"
        style={{ opacity }}
      >
        {sample.map((c, i) => (
          <span
            key={`${c.value}-${i}`}
            className="h-3.5 w-1.5 rounded-sm border border-black/20"
            style={{ backgroundColor: c.color }}
          />
        ))}
      </span>
    );
  }

  if (layer.renderer?.kind === 'class-breaks') {
    const colors = layer.renderer.colors ?? [];
    if (colors.length === 0) {
      return (
        <span
          aria-hidden="true"
          className={`${baseShape} shrink-0 border`}
          style={
            polygonHollowProps ?? {
              backgroundColor: fallback,
              borderColor: stroke,
              opacity,
            }
          }
        />
      );
    }
    // Three-step strip: first, middle, last.
    const mid = colors[Math.floor(colors.length / 2)] ?? colors[0]!;
    const stops = [colors[0]!, mid, colors[colors.length - 1]!];
    return (
      <span
        aria-hidden="true"
        className="flex h-3.5 w-3.5 shrink-0 overflow-hidden rounded-sm border border-black/20"
        style={{ opacity }}
      >
        {stops.map((c, i) => (
          <span
            key={i}
            className="h-full flex-1"
            style={{ backgroundColor: c }}
          />
        ))}
      </span>
    );
  }

  // simple renderer (or no renderer): one swatch shaped to the
  // underlying geometry so the legend reads as the same symbology
  // the worker sees on the canvas.
  return (
    <span
      aria-hidden="true"
      className={`${baseShape} shrink-0 border`}
      style={
        polygonHollowProps ?? {
          backgroundColor: fallback,
          borderColor: stroke,
          opacity,
        }
      }
    />
  );
}
