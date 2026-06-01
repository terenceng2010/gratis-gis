// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * #159 Phase 2.2 inline MapLibre snapshot for the print Map
 * element. Replaces the Phase 2.1 iframe so the captured PDF
 * gets a fully-vector(-ish) map render instead of an embedded
 * raster.
 *
 * Loads MapLibre on mount, points it at the map item's data
 * blob, and signals readiness by setting `document.body.dataset.
 * mapReady = "true"` once every layer has loaded. The Puppeteer
 * pipeline waits on this flag (via page.waitForSelector
 * `body[data-map-ready="true"]`) before calling page.pdf so the
 * captured PDF contains the fully-tiled map, not an empty
 * canvas.
 *
 * Basemap raster tiles still rasterize (PDF can't carry slippy
 * tile vector data), but vector data layers paint as path
 * primitives.
 */
import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { MapData } from '@gratis-gis/shared-types';

interface Props {
  mapData: MapData;
  basemapUrl: string | null;
}

export function MapSnapshot({ mapData, basemapUrl }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: basemapUrl ?? {
        version: 8,
        sources: {
          raster: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '(c) OpenStreetMap contributors',
          },
        },
        layers: [{ id: 'raster-layer', type: 'raster', source: 'raster' }],
      },
      center: mapData.center,
      zoom: mapData.zoom,
      bearing: mapData.bearing ?? 0,
      pitch: mapData.pitch ?? 0,
      interactive: false,
      attributionControl: false,
      // MapLibre needs `preserveDrawingBuffer: true` so the
      // canvas content is sampled by headless capture; the
      // option lives on the canvasContextAttributes bag rather
      // than top-level options in current versions.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    // Add data-layer sources via the existing portal endpoint. We
    // do this on style.load so MapLibre is ready to accept the
    // overlay layers.
    map.on('load', () => {
      for (const layer of mapData.layers ?? []) {
        if (!layer.visible) continue;
        if (layer.source.kind === 'data-layer') {
          const url = layer.source.layerKey
            ? `/api/portal/items/${layer.source.itemId}/layers/${encodeURIComponent(layer.source.layerKey)}/geojson`
            : `/api/portal/items/${layer.source.itemId}/geojson`;
          try {
            map.addSource(`pg:${layer.id}`, { type: 'geojson', data: url });
            // Add a simple circle / line / fill layer of each
            // kind so any geometry from the source paints. The
            // simple-renderer behaviour mirrors the canvas's
            // approach; full per-layer styling lands in Phase
            // 2.3.
            map.addLayer({
              id: `pg:${layer.id}:fill`,
              type: 'fill',
              source: `pg:${layer.id}`,
              filter: ['==', ['geometry-type'], 'Polygon'],
              paint: {
                'fill-color': layer.style?.polygon?.fillColor ?? '#6366f1',
                'fill-opacity':
                  layer.style?.polygon?.fillOpacity ?? 0.25,
              },
            });
            map.addLayer({
              id: `pg:${layer.id}:line`,
              type: 'line',
              source: `pg:${layer.id}`,
              filter: ['any',
                ['==', ['geometry-type'], 'LineString'],
                ['==', ['geometry-type'], 'Polygon'],
              ],
              paint: {
                'line-color': layer.style?.line?.color ?? '#4338ca',
                'line-width': layer.style?.line?.width ?? 1.5,
              },
            });
            map.addLayer({
              id: `pg:${layer.id}:circle`,
              type: 'circle',
              source: `pg:${layer.id}`,
              filter: ['==', ['geometry-type'], 'Point'],
              paint: {
                'circle-color': layer.style?.point?.color ?? '#6366f1',
                'circle-radius': layer.style?.point?.radius ?? 5,
                'circle-stroke-color':
                  layer.style?.point?.strokeColor ?? '#ffffff',
                'circle-stroke-width':
                  layer.style?.point?.strokeWidth ?? 1.5,
              },
            });
          } catch {
            // Source/layer already present (HMR) — ignore.
          }
        }
      }
      // Signal readiness once tiles + data sources have idled.
      // The Puppeteer waitForSelector picks this up.
      const markReady = () => {
        document.body.dataset.mapReady = 'true';
      };
      map.once('idle', markReady);
      // Hard ceiling so a stuck source doesn't keep Puppeteer
      // waiting forever; 12 s is well within the 30 s navigation
      // timeout the render service uses.
      setTimeout(markReady, 12_000);
    });
    return () => {
      map.remove();
    };
  }, [mapData, basemapUrl]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        background: '#f8fafc',
      }}
    />
  );
}
