// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Transient OSM features overlay on a runtime MapLibre instance
 * (#OSM).  Mounts when a recipe tool with the
 * `osm-features-overlay` output sink finishes; unmounts when the
 * user dismisses the overlay or runs the tool again.
 *
 * Owns its own MapLibre source + three layers (circles for points,
 * lines for ways / boundaries, fill+outline for polygons).  Adds an
 * ODbL attribution chip at the bottom-right of the map while any
 * overlay is mounted.  Renders nothing in the React tree; all
 * visual output goes through the MapLibre canvas.
 *
 * Multiple overlays can stack on the same map (each gets a unique
 * id); the attribution chip de-dupes so the user never sees
 * "© OpenStreetMap contributors" twice.
 */

import { useEffect } from 'react';
import type maplibregl from 'maplibre-gl';

export interface OsmOverlayFeature {
  type: 'Feature';
  id: string;
  properties: Record<string, unknown>;
  geometry: unknown;
}

interface Props {
  /** Unique id for this overlay (different overlays on the same
   *  map use unique ids so source + layer names don't collide). */
  id: string;
  map: maplibregl.Map;
  features: OsmOverlayFeature[];
  /** Tailwind-friendly color used for the fill / circle / line
   *  paint.  Defaults to a neutral accent so generic OSM results
   *  read as "not part of the user's own data." */
  color?: string;
}

export function OsmOverlayLayer({ id, map, features, color = '#7c3aed' }: Props) {
  useEffect(() => {
    const srcId = `osm-overlay/${id}`;
    const fillId = `osm-overlay-fill/${id}`;
    const lineId = `osm-overlay-line/${id}`;
    const pointId = `osm-overlay-point/${id}`;

    if (!map.getSource(srcId)) {
      map.addSource(srcId, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: features as unknown as GeoJSON.Feature[] },
      });
    } else {
      (map.getSource(srcId) as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: features as unknown as GeoJSON.Feature[],
      });
    }
    if (!map.getLayer(fillId)) {
      map.addLayer({
        id: fillId,
        type: 'fill',
        source: srcId,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': color,
          'fill-opacity': 0.2,
          'fill-outline-color': color,
        },
      });
    }
    if (!map.getLayer(lineId)) {
      map.addLayer({
        id: lineId,
        type: 'line',
        source: srcId,
        filter: ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon', 'MultiLineString', 'MultiPolygon']]],
        paint: {
          'line-color': color,
          'line-width': 2,
        },
      });
    }
    if (!map.getLayer(pointId)) {
      map.addLayer({
        id: pointId,
        type: 'circle',
        source: srcId,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-color': color,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
          'circle-radius': 6,
        },
      });
    }

    return () => {
      for (const layerId of [fillId, lineId, pointId]) {
        try {
          if (map.getLayer(layerId)) map.removeLayer(layerId);
        } catch {
          /* mid-style-swap unmount; ignore */
        }
      }
      try {
        if (map.getSource(srcId)) map.removeSource(srcId);
      } catch {
        /* ignore */
      }
    };
  }, [id, map, features, color]);

  return null;
}
