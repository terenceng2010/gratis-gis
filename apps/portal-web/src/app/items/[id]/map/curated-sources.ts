/**
 * Curated list of public, permissively-licensed GeoJSON datasets we're
 * happy to send users to by default. Each entry is a starting point for
 * someone demoing the portal or building a map they don't need to host
 * themselves.
 *
 * Guidelines for additions:
 *   - URL must serve CORS-enabled GeoJSON directly (not a zipped shapefile).
 *   - License must allow redistribution and use without attribution nags
 *     that would surprise our users. OpenStreetMap-derived datasets are
 *     fine (attribution in the basemap already covers them).
 *   - Keep file sizes reasonable; anything over 5 MB deserves a note.
 */
export interface CuratedSource {
  title: string;
  description: string;
  category: string;
  url: string;
  tags: string[];
}

export const CURATED_SOURCES: CuratedSource[] = [
  {
    title: 'World countries',
    description: 'Country polygons at medium detail. Good baseline overlay.',
    category: 'Boundaries',
    url: 'https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson',
    tags: ['polygons', 'world', 'political'],
  },
  {
    title: 'US states',
    description: 'State outlines for the United States.',
    category: 'Boundaries',
    url: 'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json',
    tags: ['polygons', 'usa', 'political'],
  },
  {
    title: 'US counties',
    description: 'County outlines for the United States (Census TIGER-derived).',
    category: 'Boundaries',
    url: 'https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json',
    tags: ['polygons', 'usa', 'counties', 'census'],
  },
  {
    title: 'World capitals',
    description: 'Points for national capital cities with population attributes.',
    category: 'Cities',
    url: 'https://raw.githubusercontent.com/datasets/world-cities/master/data/world-cities.csv',
    tags: ['points', 'world', 'cities'],
  },
  {
    title: 'Natural Earth: coastlines',
    description: 'Simplified coastline polylines, 1:110m resolution.',
    category: 'Physical',
    url: 'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/physical/ne_110m_coastline.json',
    tags: ['lines', 'coastlines', 'world', 'natural-earth'],
  },
  {
    title: 'Natural Earth: rivers',
    description: 'Major world rivers as polylines, 1:50m resolution.',
    category: 'Physical',
    url: 'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/50m/physical/ne_50m_rivers_lake_centerlines.json',
    tags: ['lines', 'rivers', 'world', 'natural-earth'],
  },
  {
    title: 'Natural Earth: lakes',
    description: 'Major lakes as polygons, 1:50m resolution.',
    category: 'Physical',
    url: 'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/50m/physical/ne_50m_lakes.json',
    tags: ['polygons', 'lakes', 'world', 'natural-earth'],
  },
  {
    title: 'US airports',
    description: 'Points for major US airports.',
    category: 'Infrastructure',
    url: 'https://raw.githubusercontent.com/plotly/datasets/master/2011_february_us_airport_traffic.csv',
    tags: ['points', 'usa', 'airports', 'transport'],
  },
  {
    title: 'World earthquakes, past week',
    description: 'Live feed of earthquakes magnitude 2.5+ for the past 7 days.',
    category: 'Events',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson',
    tags: ['points', 'live', 'earthquakes', 'usgs'],
  },
  {
    title: 'World timezones',
    description: 'IANA timezone polygons for the whole world.',
    category: 'Reference',
    url: 'https://raw.githubusercontent.com/evansiroky/timezone-boundary-builder/master/releases/timezones.geojson.zip',
    tags: ['polygons', 'timezones', 'world'],
  },
];
