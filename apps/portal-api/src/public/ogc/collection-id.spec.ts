// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseCollectionId, formatCollectionId } from './collection-id.js';

describe('parseCollectionId', () => {
  it('accepts a bare UUID as the v1 back-compat shape', () => {
    const r = parseCollectionId('123e4567-e89b-12d3-a456-426614174000');
    expect(r).toEqual({
      itemId: '123e4567-e89b-12d3-a456-426614174000',
      layerKey: null,
    });
  });

  it('accepts <itemId>__<layerKey> with the explicit form', () => {
    const r = parseCollectionId(
      '123e4567-e89b-12d3-a456-426614174000__roads',
    );
    expect(r).toEqual({
      itemId: '123e4567-e89b-12d3-a456-426614174000',
      layerKey: 'roads',
    });
  });

  it('allows hyphens, underscores, digits in the layer key', () => {
    const r = parseCollectionId(
      '123e4567-e89b-12d3-a456-426614174000__layer-2_v3',
    );
    expect(r).toEqual({
      itemId: '123e4567-e89b-12d3-a456-426614174000',
      layerKey: 'layer-2_v3',
    });
  });

  it('rejects a non-UUID prefix', () => {
    expect(parseCollectionId('not-a-uuid__layer')).toBeNull();
    expect(parseCollectionId('foo')).toBeNull();
  });

  it('rejects an empty layer key', () => {
    expect(
      parseCollectionId('123e4567-e89b-12d3-a456-426614174000__'),
    ).toBeNull();
  });

  it('rejects a layer key that contains invalid characters', () => {
    expect(
      parseCollectionId(
        '123e4567-e89b-12d3-a456-426614174000__bad/slash',
      ),
    ).toBeNull();
    expect(
      parseCollectionId(
        '123e4567-e89b-12d3-a456-426614174000__bad space',
      ),
    ).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(parseCollectionId('')).toBeNull();
  });

  it('is case-insensitive on the UUID hex segment', () => {
    const r = parseCollectionId(
      '123E4567-e89b-12D3-A456-426614174000__roads',
    );
    expect(r?.layerKey).toBe('roads');
  });
});

describe('formatCollectionId', () => {
  it('returns the bare UUID when no layer key is given', () => {
    expect(formatCollectionId('abc', null)).toBe('abc');
  });

  it('joins with double underscore when a layer key is given', () => {
    expect(formatCollectionId('abc', 'roads')).toBe('abc__roads');
  });
});
