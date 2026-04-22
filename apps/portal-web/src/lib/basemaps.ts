import type { StyleSpecification } from 'maplibre-gl';
import type { BasemapKey } from '@gratis-gis/shared-types';

export interface BasemapDef {
  key: BasemapKey;
  label: string;
  description: string;
  /** MapLibre-compatible style definition inlined as JSON. */
  style: StyleSpecification;
}

/**
 * Raster-only basemaps backed by free public tilesets. We avoid API-key
 * services in v1 so any deployment works out of the box. Swapping in
 * vector basemaps later is a matter of replacing the style object
 * without touching the rest of the app.
 */

/**
 * Public glyph endpoint for text labels. MapLibre's `symbol` layer
 * needs a glyph URL on the style or text-field rendering silently
 * fails. This points at MapLibre's public demo font pack; swap to a
 * self-hosted pack for production deployments where the dev endpoint
 * isn't appropriate.
 */
const DEFAULT_GLYPHS =
  'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf';

function rasterStyle(
  attribution: string,
  tileUrl: string,
): StyleSpecification {
  return {
    version: 8,
    glyphs: DEFAULT_GLYPHS,
    sources: {
      raster: {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: 256,
        attribution,
      },
    },
    layers: [
      {
        id: 'raster-layer',
        type: 'raster',
        source: 'raster',
      },
    ],
  };
}

export const BASEMAPS: Record<BasemapKey, BasemapDef> = {
  osm: {
    key: 'osm',
    label: 'OpenStreetMap',
    description: 'Classic OSM raster. Broad coverage, familiar styling.',
    style: rasterStyle(
      '© OpenStreetMap contributors',
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    ),
  },
  positron: {
    key: 'positron',
    label: 'Positron',
    description: 'Light and muted. Good base for overlay data.',
    style: rasterStyle(
      '© OpenStreetMap contributors © Carto',
      'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    ),
  },
  'dark-matter': {
    key: 'dark-matter',
    label: 'Dark matter',
    description: 'Dark theme for dashboards and presentations.',
    style: rasterStyle(
      '© OpenStreetMap contributors © Carto',
      'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    ),
  },
  voyager: {
    key: 'voyager',
    label: 'Voyager',
    description: 'Balanced contrast with clear place labels.',
    style: rasterStyle(
      '© OpenStreetMap contributors © Carto',
      'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
    ),
  },
  satellite: {
    key: 'satellite',
    label: 'Satellite',
    description: 'ESA WorldCover satellite imagery.',
    style: rasterStyle(
      'Imagery © ESA WorldCover',
      // Free-to-use Esri World Imagery equivalent via ArcGIS Online.
      // Swap with a self-hosted source in prod if licensing matters.
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ),
  },
};

export const BASEMAP_KEYS: BasemapKey[] = [
  'positron',
  'osm',
  'voyager',
  'dark-matter',
  'satellite',
];
