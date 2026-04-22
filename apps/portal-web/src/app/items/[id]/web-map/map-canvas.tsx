'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import maplibregl from 'maplibre-gl';
import type {
  BasemapKey,
  WebMapData,
  WebMapLayer,
  WebMapLayerFilter,
  WebMapLayerFilterClause,
} from '@gratis-gis/shared-types';
import { BASEMAPS } from '@/lib/basemaps';
import {
  MAP_ICONS,
  iconImageId,
  iconSdfImageId,
  renderIconSvg,
  renderIconSvgForSdf,
} from './map-icons';

interface Props {
  /** Controlled camera + basemap + layer list. */
  map: WebMapData;
  /** Fired whenever the user pans, zooms, rotates, or pitches. */
  onCameraChange: (next: Pick<WebMapData, 'center' | 'zoom' | 'bearing' | 'pitch'>) => void;
  /** Per-layer sets of selected feature ids (identical to feature indexes). */
  selection: Record<string, Set<number>>;
}

export interface MapCanvasHandle {
  /** Fly the camera to a bbox, padded so features aren't flush against the edges. */
  zoomTo: (bbox: [number, number, number, number]) => void;
  /**
   * Fly to a bbox or point and briefly highlight a specific feature on
   * the given layer. Used by the search bar so picking a result is
   * visually obvious even on dense maps.
   */
  flyAndHighlight: (args: {
    bbox: [number, number, number, number] | null;
    center: [number, number] | null;
    layerId?: string;
    featureId?: string | number;
    /** Feature properties used for best-effort match when no stable id. */
    featureProps?: Record<string, unknown>;
  }) => void;
}

/**
 * MapLibre canvas wired up to the declarative WebMapData shape.
 *
 * Why this is a "dumb" component: all editing actions (add layer,
 * restyle, reorder) happen outside this file. The canvas just mirrors
 * the current state — so a state update anywhere else always produces
 * a correct render with no hand-synced imperative code.
 *
 * The synchronization strategy is blunt by design: on any layer-list
 * change we tear down and rebuild our overlay sources. The underlying
 * basemap and camera survive, so the user never sees a flash. A smarter
 * diff is possible later; for now simplicity beats theoretical perf.
 */
export const MapCanvas = forwardRef<MapCanvasHandle, Props>(function MapCanvas(
  { map, onCameraChange, selection }: Props,
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const hoveredRef = useRef<{ sourceId: string; featureId: string | number } | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      zoomTo: (bbox) => {
        const m = mapRef.current;
        if (!m) return;
        m.fitBounds(
          [
            [bbox[0], bbox[1]],
            [bbox[2], bbox[3]],
          ],
          { padding: 60, duration: 600, maxZoom: 16 },
        );
      },
      flyAndHighlight: ({ bbox, center, layerId, featureProps }) => {
        const m = mapRef.current;
        if (!m) return;
        if (bbox) {
          m.fitBounds(
            [
              [bbox[0], bbox[1]],
              [bbox[2], bbox[3]],
            ],
            { padding: 80, duration: 700, maxZoom: 18 },
          );
        } else if (center) {
          m.flyTo({ center, zoom: 17, duration: 700 });
        }
        // Hover-state highlight on the matched feature. `generateId`
        // assigns stable per-session ids to geojson sources, so we can
        // queryRenderedFeatures after the camera animation settles and
        // set feature-state.
        if (!layerId) return;
        const sourceId = `gg:${layerId}`;
        const handle = () => {
          const rendered = m.querySourceFeatures(sourceId);
          const match = featureProps
            ? rendered.find((f) => propertiesMatch(f.properties, featureProps))
            : rendered[0];
          if (!match || match.id === undefined) return;
          const prevId = match.id as string | number;
          m.setFeatureState({ source: sourceId, id: prevId }, { hover: true });
          // Clear after a couple seconds so the pulse feels temporary.
          setTimeout(() => {
            m.setFeatureState({ source: sourceId, id: prevId }, { hover: false });
          }, 2500);
        };
        m.once('moveend', handle);
      },
    }),
    [],
  );

  // Tick bumped whenever a batch of icons finishes registering, so the
  // layer-sync effect can re-run and pick up the new images.
  const [iconsTick, setIconsTick] = useState(0);

  // Remember the last selection we applied to MapLibre's feature-state,
  // so we know which ids to clear when the selection shrinks. A bare
  // ref is enough — we don't need this in React state.
  const appliedSelectionRef = useRef<Record<string, Set<number>>>({});

  // Sync shared selection state → MapLibre feature-state. Diffs against
  // the previously-applied map so we only touch what changed rather
  // than walking every feature on every render.
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const prevApplied = appliedSelectionRef.current;
    const nextApplied: Record<string, Set<number>> = {};

    for (const layerId of new Set([
      ...Object.keys(prevApplied),
      ...Object.keys(selection),
    ])) {
      const sourceId = `gg:${layerId}`;
      // If the source isn't in the style (layer was deleted or still
      // loading), skip — the next syncOverlays will handle it.
      if (!m.getSource(sourceId)) continue;

      const prev = prevApplied[layerId] ?? new Set<number>();
      const next = selection[layerId] ?? new Set<number>();
      nextApplied[layerId] = next;

      for (const id of prev) {
        if (!next.has(id)) {
          m.setFeatureState({ source: sourceId, id }, { selected: false });
        }
      }
      for (const id of next) {
        if (!prev.has(id)) {
          m.setFeatureState({ source: sourceId, id }, { selected: true });
        }
      }
    }
    appliedSelectionRef.current = nextApplied;
  }, [selection, iconsTick]);

  // Wrap the callback in a ref so the stable effect below doesn't need
  // to re-bind listeners every render.
  const onCameraChangeRef = useRef(onCameraChange);
  useEffect(() => {
    onCameraChangeRef.current = onCameraChange;
  }, [onCameraChange]);

  // Create the map once; tear down on unmount.
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;
    const m = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAPS[map.basemap].style,
      center: map.center,
      zoom: map.zoom,
      bearing: map.bearing,
      pitch: map.pitch,
      attributionControl: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    const markCamera = (e: { originalEvent?: unknown }) => {
      if (!e.originalEvent) return;
      const c = m.getCenter();
      onCameraChangeRef.current({
        center: [c.lng, c.lat],
        zoom: m.getZoom(),
        bearing: m.getBearing(),
        pitch: m.getPitch(),
      });
    };
    m.on('moveend', markCamera);
    m.on('zoomend', markCamera);
    m.on('rotateend', markCamera);
    m.on('pitchend', markCamera);

    // Register the default icon library. Layer sync waits on this via
    // the `iconsTick` state: each time a batch of icons finishes
    // registering we bump the tick so the sync effect re-runs and any
    // symbol layers that were waiting on their images finally render.
    //
    // Registration is idempotent per-id, so basemap swaps that replay
    // this via 'styledata' don't duplicate images. We track a ref to
    // the tick setter so the async load callback doesn't capture a
    // stale React state function.
    let cancelled = false;
    const loadIcons = async () => {
      await Promise.all(
        Object.keys(MAP_ICONS).map(async (name) => {
          const plainId = iconImageId(name);
          const sdfId = iconSdfImageId(name);
          // Plain (as-is) variant.
          if (!m.hasImage(plainId)) {
            try {
              const svg = renderIconSvg(name);
              if (svg) {
                const img = await rasterizeSvg(svg, 48);
                if (!cancelled && !m.hasImage(plainId)) {
                  m.addImage(plainId, img, { pixelRatio: 2 });
                }
              }
            } catch {
              /* non-fatal: tinted variant or circle fallback still works */
            }
          }
          // SDF (tintable) variant. We use the plain rasterized icon
          // but flag it as SDF, so MapLibre treats the image's alpha
          // channel as a coarse distance field and tints via
          // `icon-color`. This isn't a true per-pixel SDF so edges
          // look marginally harder than tiny-sdf output, but it's
          // bulletproof — any image we can rasterize we can tint.
          if (!m.hasImage(sdfId)) {
            try {
              const svg = renderIconSvgForSdf(name);
              if (svg) {
                const sdfImg = await rasterizeSvg(svg, 48);
                if (!cancelled && !m.hasImage(sdfId)) {
                  m.addImage(sdfId, sdfImg, { pixelRatio: 2, sdf: true });
                }
              }
            } catch {
              /* non-fatal: plain variant or circle fallback still works */
            }
          }
        }),
      );
      if (!cancelled) setIconsTick((t) => t + 1);
    };
    const kickLoadIfReady = () => {
      if (!m.isStyleLoaded()) return;
      void loadIcons();
    };
    m.on('load', kickLoadIfReady);
    m.on('styledata', kickLoadIfReady);
    kickLoadIfReady();

    mapRef.current = m;
    return () => {
      cancelled = true;
      m.remove();
      mapRef.current = null;
    };
    // We intentionally create the map from initial props only; updates
    // are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // Basemap swap. Preserves camera + overlays so it feels seamless.
  //
  // MapLibre's `style.load` event does not reliably fire on subsequent
  // setStyle() calls; only `styledata` is guaranteed. We listen until we
  // see a styledata event where the style is actually ready, re-apply
  // the camera, and replay overlay layers (they're wiped by setStyle).
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const current = (m.getStyle() as { metadata?: { basemap?: BasemapKey } } | null)?.metadata
      ?.basemap;
    if (current === map.basemap) return;

    const c = m.getCenter();
    const z = m.getZoom();
    const b = m.getBearing();
    const p = m.getPitch();
    const style = { ...BASEMAPS[map.basemap].style, metadata: { basemap: map.basemap } };
    m.setStyle(style);

    const onStyleData = () => {
      if (!m.isStyleLoaded()) return;
      m.off('styledata', onStyleData);
      m.jumpTo({ center: [c.lng, c.lat], zoom: z, bearing: b, pitch: p });
      syncOverlays(m, map.layers, hoveredRef);
    };
    m.on('styledata', onStyleData);
  }, [map.basemap, map.layers]);

  // Keep overlay layers (everything after the basemap) in sync with props.
  // Depends on iconsTick so the sync re-runs once each icon batch
  // finishes registering — otherwise a symbol layer can be added
  // referencing an image that MapLibre hasn't received yet, and it
  // silently renders nothing.
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    // Wait for style to be fully loaded, otherwise addSource throws.
    if (!m.isStyleLoaded()) {
      const once = () => {
        syncOverlays(m, map.layers, hoveredRef);
        m.off('load', once);
      };
      m.on('load', once);
      return;
    }
    syncOverlays(m, map.layers, hoveredRef);
  }, [map.layers, iconsTick]);

  // Click handlers for popups, hover handlers for highlight + cursor.
  // Attached once, dispatches dynamically based on the current layer set.
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;

    // Only query layer ids that actually exist in the current style.
    // Asking MapLibre to filter by an unknown layer silently returns
    // zero hits, which made popups and hover appear totally dead when
    // a layer's optional variants (e.g. `-label`) weren't registered.
    const interactiveLayerIds = (): string[] => {
      const style = m.getStyle();
      const existing = new Set((style.layers ?? []).map((sl) => sl.id));
      const wanted = map.layers.flatMap((l) => overlayLayerIds(l.id));
      return wanted.filter((id) => existing.has(id));
    };

    function onMouseMove(e: maplibregl.MapMouseEvent) {
      const hits = m!.queryRenderedFeatures(e.point, {
        layers: interactiveLayerIds(),
      });
      m!.getCanvas().style.cursor = hits.length > 0 ? 'pointer' : '';

      // Clear previous hover state, then set the new one.
      const cur = hoveredRef.current;
      if (cur) {
        m!.setFeatureState(
          { source: cur.sourceId, id: cur.featureId },
          { hover: false },
        );
        hoveredRef.current = null;
      }
      const hit = hits[0];
      if (hit && hit.id !== undefined) {
        // feature-state needs ids; GeoJSON features have `id` only if
        // the source was added with generateId: true (we do).
        m!.setFeatureState(
          { source: hit.source, id: hit.id },
          { hover: true },
        );
        hoveredRef.current = {
          sourceId: hit.source,
          featureId: hit.id as string | number,
        };
      }
    }
    function onMouseLeave() {
      const cur = hoveredRef.current;
      if (!cur || !m) return;
      m.setFeatureState(
        { source: cur.sourceId, id: cur.featureId },
        { hover: false },
      );
      hoveredRef.current = null;
      m.getCanvas().style.cursor = '';
    }
    function onClick(e: maplibregl.MapMouseEvent) {
      const hits = m!.queryRenderedFeatures(e.point, {
        layers: interactiveLayerIds(),
      });
      const hit = hits[0];
      if (!hit) {
        popupRef.current?.remove();
        popupRef.current = null;
        return;
      }
      // Which layer does this feature belong to?
      const layer = map.layers.find((l) =>
        overlayLayerIds(l.id).some((id) => id === hit.layer.id),
      );
      if (!layer || !layer.popup.enabled) return;
      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({ closeOnClick: true, maxWidth: '320px' })
        .setLngLat(e.lngLat)
        .setHTML(renderPopupHtml(layer, hit.properties ?? {}))
        .addTo(m!);
    }

    m.on('mousemove', onMouseMove);
    m.on('mouseleave', onMouseLeave);
    m.on('click', onClick);
    return () => {
      m.off('mousemove', onMouseMove);
      m.off('mouseleave', onMouseLeave);
      m.off('click', onClick);
    };
  }, [map.layers]);

  // Camera sync: only push external camera changes into MapLibre, don't
  // fight the user's pan/zoom gestures.
  const externalCamera = useMemo(
    () => ({
      center: map.center,
      zoom: map.zoom,
      bearing: map.bearing,
      pitch: map.pitch,
    }),
    [map.center, map.zoom, map.bearing, map.pitch],
  );
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const c = m.getCenter();
    const sameCenter =
      Math.abs(c.lng - externalCamera.center[0]) < 1e-9 &&
      Math.abs(c.lat - externalCamera.center[1]) < 1e-9;
    if (
      sameCenter &&
      m.getZoom() === externalCamera.zoom &&
      m.getBearing() === externalCamera.bearing &&
      m.getPitch() === externalCamera.pitch
    ) {
      return;
    }
    // Reset: programmatic moves shouldn't echo as user changes.
    m.jumpTo({
      center: externalCamera.center,
      zoom: externalCamera.zoom,
      bearing: externalCamera.bearing,
      pitch: externalCamera.pitch,
    });
  }, [externalCamera]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden rounded-lg border border-border shadow-card"
    />
  );
});

/**
 * Load an SVG string onto a canvas and return the raw pixels. Used to
 * turn the bundled icon library into images MapLibre can register via
 * addImage(). We render at 2x physical pixels (96 × 96 pixels for a
 * 48 × 48 icon) so high-DPI displays stay crisp.
 */
async function rasterizeSvg(svg: string, size: number): Promise<ImageData> {
  const scale = 2;
  const w = size * scale;
  const h = size * scale;
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = (e) => reject(e);
      i.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2D unavailable');
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Shallow property-match. Used only for search highlight fallback
 * where feature ids aren't stable across fetches. We compare the
 * stringified primitives of the subset we care about (search result
 * carries the exact properties the result was built from).
 */
function propertiesMatch(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown>,
): boolean {
  if (!a) return false;
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || v === null) continue;
    if (String(a[k]) !== String(v)) return false;
  }
  return true;
}

/** Ids of the MapLibre style-layers this WebMapLayer may contribute. */
function overlayLayerIds(layerId: string): string[] {
  return [
    `gg:${layerId}-fill`,
    `gg:${layerId}-poly-line`,
    `gg:${layerId}-line`,
    `gg:${layerId}-icon-halo`,
    `gg:${layerId}-circle`,
    `gg:${layerId}-label`,
  ];
}

/**
 * Remove any overlay sources + layers from a previous render, then add
 * the current set. Stable identifiers mean teardown is mechanical.
 */
function syncOverlays(
  m: maplibregl.Map,
  layers: WebMapLayer[],
  hoveredRef: React.MutableRefObject<{ sourceId: string; featureId: string | number } | null>,
) {
  // Remove previously-added overlay layers. Everything we own starts
  // with `gg:` so we can distinguish from basemap layers.
  const style = m.getStyle();
  if (style?.layers) {
    for (const l of style.layers) {
      if (l.id.startsWith('gg:')) m.removeLayer(l.id);
    }
  }
  if (style?.sources) {
    for (const id of Object.keys(style.sources)) {
      if (id.startsWith('gg:')) {
        try {
          m.removeSource(id);
        } catch {
          // Ignore races; a subsequent render will fix it.
        }
      }
    }
  }
  hoveredRef.current = null;

  for (const layer of layers) {
    if (!layer.visible) continue;
    const sourceId = `gg:${layer.id}`;
    const data = sourceData(layer);
    if (!data) continue;
    m.addSource(sourceId, {
      type: 'geojson',
      data,
      generateId: true,
    });

    const op = layer.opacity;
    const s = layer.style;
    const hover = layer.interactions.hoverHighlight;

    // Colors may be driven by an attribute (unique-value renderer). The
    // helper returns either a MapLibre match expression or the plain
    // hex we were using before.
    const polyFill = rendererColor(layer, s.polygon.fillColor);
    const polyStroke = rendererColor(layer, s.polygon.strokeColor);
    const lineColor = rendererColor(layer, s.line.color);
    const pointFill = rendererColor(layer, s.point.color);

    // Build a state-aware "case" expression. `selected` beats `hover`
    // which beats the base value. Includes an optional hover branch
    // only when hover highlighting is enabled on the layer, so we
    // don't bloat the expression when nobody's hovering anywhere.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stateCase = (base: any, selectedValue: any, hoverValue: any): any => {
      const expr: any[] = ['case'];
      expr.push(['boolean', ['feature-state', 'selected'], false], selectedValue);
      if (hover) {
        expr.push(['boolean', ['feature-state', 'hover'], false], hoverValue);
      }
      expr.push(base);
      return expr;
    };

    const SEL_ACCENT = '#2563eb';

    // Polygon fill. Selection bumps opacity so picked polygons read as
    // highlighted even against a translucent base style.
    m.addLayer({
      id: `gg:${layer.id}-fill`,
      type: 'fill',
      source: sourceId,
      filter: combineFilter(['==', ['geometry-type'], 'Polygon'], layer.filter),
      paint: {
        'fill-color': polyFill,
        'fill-opacity': stateCase(
          s.polygon.fillOpacity * op,
          Math.min(1, s.polygon.fillOpacity + 0.4) * op,
          Math.min(1, s.polygon.fillOpacity + 0.25) * op,
        ) as unknown as number,
      },
    });

    // Polygon outline (separate layer so paint rules stay simple).
    // Selected polygons get an accent color and a thicker outline so
    // the pick is obvious without repainting the fill.
    m.addLayer({
      id: `gg:${layer.id}-poly-line`,
      type: 'line',
      source: sourceId,
      filter: combineFilter(['==', ['geometry-type'], 'Polygon'], layer.filter),
      paint: {
        'line-color': stateCase(
          polyStroke,
          SEL_ACCENT,
          polyStroke,
        ) as unknown as string,
        'line-width': stateCase(
          s.polygon.strokeWidth,
          s.polygon.strokeWidth + 2,
          s.polygon.strokeWidth + 1,
        ) as unknown as number,
        'line-opacity': op,
      },
    });

    // LineString geometries
    m.addLayer({
      id: `gg:${layer.id}-line`,
      type: 'line',
      source: sourceId,
      filter: combineFilter(['==', ['geometry-type'], 'LineString'], layer.filter),
      paint: {
        'line-color': stateCase(
          lineColor,
          SEL_ACCENT,
          lineColor,
        ) as unknown as string,
        'line-width': stateCase(
          s.line.width,
          s.line.width + 2,
          s.line.width + 1,
        ) as unknown as number,
        'line-opacity': op,
      },
    });

    // Point geometries. When the layer's point style picks an icon
    // symbol, try to render a MapLibre symbol layer with the right
    // image variant (SDF for tinted, plain for as-shipped). When the
    // image hasn't been registered yet, fall back to a circle so the
    // feature stays visible while images load or if the icon name
    // is typo'd.
    const wantsIcon = s.point.symbol === 'icon' && !!s.point.iconName;
    const tint = s.point.iconTint !== false; // default true
    const preferredId = wantsIcon
      ? tint
        ? iconSdfImageId(s.point.iconName)
        : iconImageId(s.point.iconName)
      : '';
    const iconReady = wantsIcon && m.hasImage(preferredId);
    if (iconReady) {
      // Selection halo under the icon. Rendered as a separate circle
      // layer so it reads through whatever the symbol shows on top —
      // works for both SDF and plain icon variants.
      m.addLayer({
        id: `gg:${layer.id}-icon-halo`,
        type: 'circle',
        source: sourceId,
        filter: combineFilter(['==', ['geometry-type'], 'Point'], layer.filter),
        paint: {
          'circle-color': 'rgba(37, 99, 235, 0.25)',
          'circle-radius': stateCase(0, 14 * s.point.iconSize, 0) as unknown as number,
          'circle-stroke-color': SEL_ACCENT,
          'circle-stroke-width': stateCase(0, 2, 0) as unknown as number,
          'circle-opacity': op,
        },
      });
      m.addLayer({
        id: `gg:${layer.id}-circle`,
        type: 'symbol',
        source: sourceId,
        filter: combineFilter(['==', ['geometry-type'], 'Point'], layer.filter),
        layout: {
          'icon-image': preferredId,
          'icon-size': stateCase(
            s.point.iconSize,
            s.point.iconSize * 1.15,
            s.point.iconSize * 1.2,
          ) as unknown as number,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-anchor': 'bottom',
        },
        paint: {
          'icon-opacity': op,
          // icon-color only takes effect when the image was registered
          // with sdf: true. For the plain variant this paint property
          // is ignored, which is exactly what we want.
          ...(tint ? { 'icon-color': pointFill } : {}),
        },
      });
    } else {
      m.addLayer({
        id: `gg:${layer.id}-circle`,
        type: 'circle',
        source: sourceId,
        filter: combineFilter(['==', ['geometry-type'], 'Point'], layer.filter),
        paint: {
          'circle-color': pointFill,
          'circle-radius': stateCase(
            s.point.radius,
            s.point.radius + 3,
            s.point.radius + 2,
          ) as unknown as number,
          'circle-stroke-color': stateCase(
            s.point.strokeColor,
            SEL_ACCENT,
            s.point.strokeColor,
          ) as unknown as string,
          'circle-stroke-width': stateCase(
            s.point.strokeWidth,
            s.point.strokeWidth + 2,
            s.point.strokeWidth,
          ) as unknown as number,
          'circle-opacity': op,
          'circle-stroke-opacity': op,
        },
      });
    }

    // Text labels. Only add the symbol layer when enabled + a non-
    // empty template is present; an empty text-field renders as blank
    // symbols and still incurs MapLibre's layout cost.
    const labels = layer.labels;
    if (labels?.enabled && labels.template) {
      const textExpr = templateToExpression(labels.template);
      const symbolLayer: maplibregl.SymbolLayerSpecification = {
        id: `gg:${layer.id}-label`,
        type: 'symbol',
        source: sourceId,
        layout: {
          'text-field': textExpr as unknown as maplibregl.DataDrivenPropertyValueSpecification<string>,
          'text-size': labels.size,
          'text-anchor': labels.anchor,
          'text-offset': [labels.offsetX, labels.offsetY],
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'text-padding': 2,
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          'symbol-placement': labels.placement === 'line' ? 'line' : 'point',
        },
        paint: {
          'text-color': labels.color,
          'text-halo-color': labels.haloColor,
          'text-halo-width': labels.haloWidth,
          'text-opacity': op,
        },
      };
      if (layer.filter) {
        symbolLayer.filter = combineFilter(
          ['all'],
          layer.filter,
        ) as maplibregl.FilterSpecification;
      }
      m.addLayer(symbolLayer);
    }
  }
}

/**
 * Translate a Handlebars-lite template into a MapLibre text-field
 * expression. `"Pop: {{pop | number}}"` becomes
 * `['concat', 'Pop: ', <to-string get pop>]`; `"{{name}}"` becomes a
 * straight `to-string(get(name))`. Formatter pipes are honored
 * client-side at layout time by concatenating a formatted value into
 * the text; we keep the vocabulary aligned with popup formatters so
 * authors only have to learn one mental model.
 *
 * If the template has no tokens, the whole string renders as literal
 * text, which MapLibre accepts directly.
 */
function templateToExpression(template: string): unknown {
  const re = /\{\{\s*([\w.-]+)\s*(?:\|\s*([\w.-]+)(?:\s*:\s*([^}]+))?\s*)?\}\}/g;
  const parts: unknown[] = [];
  let lastIndex = 0;
  for (
    let match = re.exec(template);
    match !== null;
    match = re.exec(template)
  ) {
    const [full, field, formatter, arg] = match;
    if (match.index > lastIndex) {
      parts.push(template.slice(lastIndex, match.index));
    }
    parts.push(formatterExpression(field!, formatter, arg));
    lastIndex = match.index + full.length;
  }
  if (lastIndex < template.length) {
    parts.push(template.slice(lastIndex));
  }
  if (parts.length === 0) return '';
  if (parts.length === 1 && typeof parts[0] === 'string') return parts[0];
  return ['concat', ...parts];
}

/**
 * Per-token MapLibre expression. Formatters that map cleanly to
 * MapLibre's expression language (upper/lower/number with locale
 * coercion) are inlined; formatters MapLibre can't express
 * (currency with a specific locale, date with a style) fall back to
 * plain to-string with a comment — the popup renderer still honors
 * them on click, this just means the *label* won't format them.
 */
function formatterExpression(
  field: string,
  formatter?: string,
  _arg?: string,
): unknown {
  const base = ['to-string', ['get', field]];
  switch (formatter?.toLowerCase()) {
    case 'upper':
      return ['upcase', base];
    case 'lower':
      return ['downcase', base];
    case 'number': {
      // MapLibre has `number-format`; we coerce to number first so
      // string-valued numerics still format.
      return [
        'number-format',
        ['to-number', ['get', field]],
        { 'min-fraction-digits': 0 },
      ];
    }
    default:
      return base;
  }
}

type MlFilter = maplibregl.FilterSpecification;

/**
 * Translate a single filter clause to a MapLibre expression, or return
 * null if the clause is incomplete / unfit for the chosen operator
 * (e.g. a numeric comparison whose value is not a valid number).
 */
function clauseToExpr(clause: WebMapLayerFilterClause): unknown[] | null {
  if (!clause.field) return null;
  const prop = ['get', clause.field];
  switch (clause.op) {
    case '==':
      return ['==', prop, clause.value];
    case '!=':
      return ['!=', prop, clause.value];
    case '>':
    case '>=':
    case '<':
    case '<=': {
      const n = Number(clause.value);
      if (Number.isNaN(n)) return null;
      return [clause.op, prop, n];
    }
    case 'contains':
      return ['>=', ['index-of', clause.value, ['to-string', prop]], 0];
    case 'is-null':
      return ['!', ['has', clause.field]];
    case 'is-not-null':
      return ['has', clause.field];
  }
}

/**
 * Combine the always-on geometry-type filter with any attribute clauses.
 * Clauses are joined via the user's chosen combinator (all == AND,
 * any == OR). Incomplete clauses (no field picked yet, or numeric
 * comparison with a non-numeric value) are silently dropped so the
 * map keeps rendering while the user is mid-edit.
 */
function combineFilter(
  geomFilter: unknown[],
  filter: WebMapLayerFilter | null,
): MlFilter {
  if (!filter || filter.clauses.length === 0) return geomFilter as MlFilter;
  const exprs = filter.clauses
    .map((c) => clauseToExpr(c))
    .filter((e): e is unknown[] => e !== null);
  if (exprs.length === 0) return geomFilter as MlFilter;
  const joined = [filter.combinator === 'any' ? 'any' : 'all', ...exprs];
  return (['all', geomFilter, joined] as unknown) as MlFilter;
}

/**
 * Build a MapLibre paint color for a given style slot, honoring the
 * layer's renderer. Simple renderer → raw hex. Unique-values renderer
 * → a `match` expression against the field, defaulting to the simple
 * color for anything unlisted.
 *
 * Returns `any` because MapLibre paint values are typed as massive
 * unions; TS check isn't losing much here and gains a lot of
 * readability.
 */
// Return type is MapLibre's DataDrivenPropertyValueSpecification<string>
// in practice, but that union is huge. Use `any` at this boundary to
// keep the call sites clean; the runtime shape is exactly what the
// paint-property validator expects.
function rendererColor(
  layer: WebMapLayer,
  fallback: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const r = layer.renderer;
  if (r.kind === 'simple') return fallback;

  if (r.kind === 'unique-values') {
    if (r.categories.length === 0 || !r.field) return fallback;
    const matchExpr: unknown[] = ['match', ['to-string', ['get', r.field]]];
    for (const cat of r.categories) {
      matchExpr.push(cat.value, cat.color);
    }
    matchExpr.push(fallback); // default
    return matchExpr;
  }

  // class-breaks. MapLibre `step(input, out0, stop1, out1, stop2, out2, ...)`
  // returns out0 when input < stop1, out1 when stop1 <= input < stop2, etc.
  // We need one more color than stops; fall back to the simple color if
  // the editor hasn't finished wiring this up.
  if (r.kind === 'class-breaks') {
    if (!r.field || r.stops.length === 0 || r.colors.length !== r.stops.length + 1) {
      return fallback;
    }
    const input = ['to-number', ['get', r.field]];
    const stepExpr: unknown[] = ['step', input, r.colors[0]];
    for (let i = 0; i < r.stops.length; i += 1) {
      stepExpr.push(r.stops[i]);
      stepExpr.push(r.colors[i + 1]);
    }
    return stepExpr;
  }

  return fallback;
}

/**
 * Resolve a layer source into something MapLibre can chew on:
 *   - `geojson-url` returns the URL as-is.
 *   - `geojson-inline` returns the inline collection as-is.
 *   - `feature-service` returns the portal API URL that serves the
 *     referenced item; an upstream cookie-bearing request resolves to
 *     the GeoJSON inside the item's dataJson.
 *
 * Returning a URL for feature-service means MapLibre handles the fetch
 * (and its own cache / cancellation). The API route passes through
 * our auth, so no credentials juggling client-side.
 */
function sourceData(layer: WebMapLayer): GeoJSON.FeatureCollection | string | null {
  if (layer.source.kind === 'geojson-url') return layer.source.url;
  if (layer.source.kind === 'geojson-inline') {
    return layer.source.geojson as GeoJSON.FeatureCollection;
  }
  if (layer.source.kind === 'feature-service') {
    // The server-side API endpoint emits the GeoJSON directly; see
    // apps/portal-api/src/items/items.controller.ts `@Get(':id/geojson')`.
    return `/api/portal/items/${layer.source.itemId}/geojson`;
  }
  return null;
}

/**
 * Build popup HTML from a feature's properties. Honors popup.fields
 * (order + subset) when non-empty; otherwise shows everything.
 * Renders as a definition list for screen readers.
 *
 * Values are HTML-escaped because they're user-provided data.
 */
function renderPopupHtml(
  layer: WebMapLayer,
  props: Record<string, unknown>,
): string {
  const title = layer.popup.titleTemplate
    ? renderTemplate(layer.popup.titleTemplate, props)
    : layer.title;

  // Body shape depends on mode. Template mode passes through author
  // markup with values HTML-escaped; picked / all render as a
  // definition list so unstyled layers still look decent.
  let body: string;
  if (layer.popup.mode === 'template' && layer.popup.bodyTemplate) {
    body = `<div class="gg-popup-body">${renderTemplate(
      layer.popup.bodyTemplate,
      props,
    )}</div>`;
  } else {
    const keys =
      layer.popup.mode === 'picked'
        ? layer.popup.fields
        : Object.keys(props).sort();
    const rows = keys
      .map((k) => {
        const v = props[k];
        if (v === null || v === undefined || v === '') return '';
        return `
          <div class="gg-popup-row">
            <dt>${escapeHtml(k)}</dt>
            <dd>${escapeHtml(String(v))}</dd>
          </div>
        `;
      })
      .filter(Boolean)
      .join('');
    body = `<dl>${rows || '<div class="gg-popup-empty">No properties</div>'}</dl>`;
  }

  return `
    <div class="gg-popup">
      <div class="gg-popup-title">${escapeHtml(title)}</div>
      ${body}
    </div>
  `;
}

/**
 * Handlebars-lite interpolation.
 *
 *   {{field}}               → raw value
 *   {{field | upper}}       → uppercased
 *   {{field | lower}}       → lowercased
 *   {{price | number}}      → locale-formatted number
 *   {{price | currency}}    → locale currency (user's default)
 *   {{date | date}}         → locale-formatted date/time
 *   {{date | date:short}}   → short date
 *
 * Template literals are rendered as HTML so authors can use small
 * markup (`<br>`, `<strong>`). Values are always HTML-escaped, so a
 * property containing `<script>` can't inject behavior.
 */
function renderTemplate(template: string, props: Record<string, unknown>): string {
  return template.replace(
    /\{\{\s*([\w.-]+)\s*(?:\|\s*([\w.-]+)(?:\s*:\s*([^}]+))?\s*)?\}\}/g,
    (_, key: string, formatter?: string, arg?: string) => {
      const raw = props[key];
      if (raw === undefined || raw === null) return '';
      const formatted = applyFormatter(raw, formatter, arg);
      return escapeHtml(formatted);
    },
  );
}

function applyFormatter(
  raw: unknown,
  formatter: string | undefined,
  arg: string | undefined,
): string {
  const str = String(raw);
  if (!formatter) return str;
  switch (formatter.toLowerCase()) {
    case 'upper':
      return str.toUpperCase();
    case 'lower':
      return str.toLowerCase();
    case 'number': {
      const n = Number(str);
      if (Number.isNaN(n)) return str;
      return n.toLocaleString();
    }
    case 'currency': {
      const n = Number(str);
      if (Number.isNaN(n)) return str;
      const currency = arg?.trim() || 'USD';
      try {
        return n.toLocaleString(undefined, { style: 'currency', currency });
      } catch {
        return n.toLocaleString();
      }
    }
    case 'date': {
      const d = new Date(str);
      if (Number.isNaN(d.getTime())) return str;
      const style = (arg?.trim() as 'short' | 'long' | 'full' | undefined) ?? 'medium';
      try {
        return d.toLocaleDateString(undefined, { dateStyle: style });
      } catch {
        return d.toLocaleDateString();
      }
    }
    default:
      return str;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
