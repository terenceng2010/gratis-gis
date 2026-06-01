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
import type { MapData, MapLayer } from '@gratis-gis/shared-types';

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
    map.on('load', async () => {
      // Per-source-kind handlers. Each one adds a GeoJSON source
      // and the matching circle/line/fill layers via the shared
      // helper. arcgis-rest + postgis-live both kick off a bbox
      // fetch against the current viewport.
      const bounds = map.getBounds();
      const bbox: [number, number, number, number] = [
        bounds.getWest(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getNorth(),
      ];
      const tasks: Array<Promise<void>> = [];
      for (const layer of mapData.layers ?? []) {
        if (!layer.visible) continue;
        if (layer.source.kind === 'data-layer') {
          const url = layer.source.layerKey
            ? `/api/portal/items/${layer.source.itemId}/layers/${encodeURIComponent(layer.source.layerKey)}/geojson`
            : `/api/portal/items/${layer.source.itemId}/geojson`;
          addGeoJsonSourceFromUrl(map, layer.id, url, layer);
        } else if (layer.source.kind === 'arcgis-rest') {
          // ArcGIS REST queries return GeoJSON when f=geojson; bbox
          // is encoded as the geometry parameter.
          const src = layer.source as {
            kind: 'arcgis-rest';
            url: string;
            layerId: number;
            proxyUrl?: string;
          };
          const params = new URLSearchParams({
            where: '1=1',
            geometry: bbox.join(','),
            geometryType: 'esriGeometryEnvelope',
            inSR: '4326',
            spatialRel: 'esriSpatialRelIntersects',
            outFields: '*',
            outSR: '4326',
            f: 'geojson',
            resultRecordCount: '2000',
          });
          const baseUrl = src.proxyUrl ?? src.url;
          const queryUrl = `${baseUrl}/${src.layerId}/query?${params.toString()}`;
          tasks.push(
            fetch(queryUrl)
              .then((r) => r.json())
              .then((data) => {
                addGeoJsonSourceFromData(
                  map,
                  layer.id,
                  data as GeoJSON.FeatureCollection,
                  layer,
                );
              })
              .catch(() => undefined),
          );
        } else if (layer.source.kind === 'postgis-live') {
          const src = layer.source as {
            kind: 'postgis-live';
            serviceItemId: string;
            tableName: string;
            whereClause?: string;
          };
          tasks.push(
            fetch(
              `/api/portal/postgis-live/${src.serviceItemId}/features`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  tableName: src.tableName,
                  bbox,
                  ...(src.whereClause ? { whereClause: src.whereClause } : {}),
                }),
              },
            )
              .then((r) => r.json())
              .then((data) => {
                addGeoJsonSourceFromData(
                  map,
                  layer.id,
                  data as GeoJSON.FeatureCollection,
                  layer,
                );
              })
              .catch(() => undefined),
          );
        }
      }
      await Promise.all(tasks);
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

/**
 * Add a GeoJSON-from-URL source + the matching circle / line /
 * fill layers. Shared between every source kind that ends up
 * with a remote URL (today: data-layer; arcgis-rest + postgis-
 * live take the data path because they POST a bbox-filtered
 * payload rather than handing MapLibre a static URL).
 */
function addGeoJsonSourceFromUrl(
  map: maplibregl.Map,
  layerId: string,
  url: string,
  layer: MapLayer,
): void {
  try {
    map.addSource(`pg:${layerId}`, { type: 'geojson', data: url });
    addPaintLayers(map, layerId, layer);
  } catch {
    /* HMR re-add — ignore */
  }
}

/**
 * Same as the URL variant, but accepts an already-fetched
 * FeatureCollection. Used for sources that POST a bbox payload
 * to portal-api and need the response data plugged into the
 * source directly (arcgis-rest, postgis-live).
 */
function addGeoJsonSourceFromData(
  map: maplibregl.Map,
  layerId: string,
  data: GeoJSON.FeatureCollection,
  layer: MapLayer,
): void {
  try {
    map.addSource(`pg:${layerId}`, { type: 'geojson', data });
    addPaintLayers(map, layerId, layer);
  } catch {
    /* HMR re-add — ignore */
  }
}

function addPaintLayers(
  map: maplibregl.Map,
  layerId: string,
  layer: MapLayer,
): void {
  map.addLayer({
    id: `pg:${layerId}:fill`,
    type: 'fill',
    source: `pg:${layerId}`,
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: {
      'fill-color': layer.style?.polygon?.fillColor ?? '#6366f1',
      'fill-opacity': layer.style?.polygon?.fillOpacity ?? 0.25,
    },
  });
  map.addLayer({
    id: `pg:${layerId}:line`,
    type: 'line',
    source: `pg:${layerId}`,
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
    id: `pg:${layerId}:circle`,
    type: 'circle',
    source: `pg:${layerId}`,
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-color': layer.style?.point?.color ?? '#6366f1',
      'circle-radius': layer.style?.point?.radius ?? 5,
      'circle-stroke-color': layer.style?.point?.strokeColor ?? '#ffffff',
      'circle-stroke-width': layer.style?.point?.strokeWidth ?? 1.5,
    },
  });
}
