// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  buildOverpassQl,
  escapeOverpassTagKey,
  escapeOverpassTagValue,
} from './overpass-ql.js';
import type { OsmPreset } from './preset-catalog.js';

const FUEL: OsmPreset = {
  id: 'amenity_fuel',
  label: 'Gas Station',
  category: 'amenity',
  tags: [{ key: 'amenity', value: 'fuel' }],
  geometries: ['node', 'way'],
};

const CHARGING: OsmPreset = {
  id: 'amenity_charging_station',
  label: 'EV charging station',
  category: 'amenity',
  tags: [{ key: 'amenity', value: 'charging_station' }],
  geometries: ['node'],
};

const LAKE: OsmPreset = {
  id: 'natural_water_lake',
  label: 'Lake',
  category: 'natural',
  tags: [
    { key: 'natural', value: 'water' },
    { key: 'water', value: 'lake' },
  ],
  geometries: ['way', 'relation'],
};

describe('buildOverpassQl', () => {
  it('renders one stanza per (preset, geometry) pair', () => {
    const ql = buildOverpassQl({
      presets: [FUEL],
      bbox: [-80, 38, -79, 39],
    });
    expect(ql).toMatch(/\[out:json\]\[timeout:25\]/);
    expect(ql).toMatch(/node\["amenity"="fuel"\]\(38,-80,39,-79\);/);
    expect(ql).toMatch(/way\["amenity"="fuel"\]\(38,-80,39,-79\);/);
    expect(ql).toMatch(/out body geom tags;/);
  });

  it('unions multiple presets with the same tag filter', () => {
    const ql = buildOverpassQl({
      presets: [FUEL, CHARGING],
      tagFilters: [{ key: 'brand', value: 'Citgo' }],
      bbox: [-80, 38, -79, 39],
    });
    // Two presets x (node + way for fuel) + (node for charging) = 3 stanzas
    expect(
      ql.match(/^\s*(node|way|relation)/gm)?.length,
    ).toBe(3);
    // Every stanza carries the brand filter.
    expect(ql.match(/\["brand"="Citgo"\]/g)?.length).toBe(3);
  });

  it('emits the multi-tag preset shape correctly', () => {
    const ql = buildOverpassQl({
      presets: [LAKE],
      bbox: [-80, 38, -79, 39],
    });
    expect(ql).toMatch(/way\["natural"="water"\]\["water"="lake"\]/);
    expect(ql).toMatch(/relation\["natural"="water"\]\["water"="lake"\]/);
  });

  it('ignores non-equals filter ops in v1', () => {
    const ql = buildOverpassQl({
      presets: [FUEL],
      tagFilters: [
        { key: 'brand', value: 'Citgo' },
        { key: 'name', value: 'Sunoco', op: 'regex' },
      ],
      bbox: [-80, 38, -79, 39],
    });
    expect(ql).toMatch(/\["brand"="Citgo"\]/);
    expect(ql).not.toMatch(/\["name"=/);
  });

  it('renders a wildcard preset value as a key-presence clause', () => {
    const ql = buildOverpassQl({
      presets: [
        {
          ...FUEL,
          tags: [{ key: 'amenity', value: '*' }],
        },
      ],
      bbox: [-80, 38, -79, 39],
    });
    expect(ql).toMatch(/node\["amenity"\]\(/);
    expect(ql).not.toMatch(/\["amenity"="\*"\]/);
  });

  it('escapes embedded quotes + backslashes in tag values', () => {
    const ql = buildOverpassQl({
      presets: [FUEL],
      tagFilters: [{ key: 'brand', value: 'O"Hara\\' }],
      bbox: [-80, 38, -79, 39],
    });
    expect(ql).toMatch(/\["brand"="O\\"Hara\\\\"\]/);
  });

  it('rejects an empty preset array', () => {
    expect(() =>
      buildOverpassQl({ presets: [], bbox: [-80, 38, -79, 39] }),
    ).toThrow(/at least one preset/);
  });

  it('rejects a degenerate bbox', () => {
    expect(() =>
      buildOverpassQl({ presets: [FUEL], bbox: [-79, 38, -80, 39] }),
    ).toThrow(/degenerate/);
    expect(() =>
      buildOverpassQl({ presets: [FUEL], bbox: [-80, 39, -79, 38] }),
    ).toThrow(/degenerate/);
  });

  it('rejects a bbox outside the geographic range', () => {
    expect(() =>
      buildOverpassQl({ presets: [FUEL], bbox: [-200, 38, -79, 39] }),
    ).toThrow(/outside the geographic range/);
  });

  it('honours a custom timeout', () => {
    const ql = buildOverpassQl({
      presets: [FUEL],
      bbox: [-80, 38, -79, 39],
      timeoutSeconds: 60,
    });
    expect(ql).toMatch(/timeout:60/);
  });
});

describe('escapeOverpassTagKey', () => {
  it('passes alphanumeric + underscore + colon through', () => {
    expect(escapeOverpassTagKey('amenity')).toBe('amenity');
    expect(escapeOverpassTagKey('addr:city')).toBe('addr:city');
    expect(escapeOverpassTagKey('opening_hours')).toBe('opening_hours');
  });

  it('rejects unsupported characters', () => {
    expect(() => escapeOverpassTagKey('amenity"')).toThrow();
    expect(() => escapeOverpassTagKey('amenity ')).toThrow();
    expect(() => escapeOverpassTagKey('amenity=fuel')).toThrow();
  });
});

describe('escapeOverpassTagValue', () => {
  it('passes ascii through', () => {
    expect(escapeOverpassTagValue('Citgo')).toBe('Citgo');
  });

  it('escapes backslash + quote', () => {
    expect(escapeOverpassTagValue('a"b\\c')).toBe('a\\"b\\\\c');
  });

  it('rejects control characters', () => {
    expect(() => escapeOverpassTagValue('a\x00b')).toThrow();
    expect(() => escapeOverpassTagValue('a\nb')).toThrow();
  });
});
