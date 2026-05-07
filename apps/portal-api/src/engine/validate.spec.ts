// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ObservationValidationError,
  type Observation,
  uuidv7,
  validateObservation,
} from '@gratis-gis/engine';

function fixture(overrides: Partial<Observation> = {}): Observation {
  return {
    validFrom: new Date('2026-01-01T00:00:00Z'),
    validTo: null,
    scope: 'data_layer:test',
    entity: uuidv7(),
    kind: 'create',
    attrs: { name: 'test' },
    geom: { type: 'Point', coordinates: [-111.65, 40.6] },
    author: { sub: 'user-123', displayName: 'Test User' },
    source: { kind: 'web' },
    parents: [],
    ...overrides,
  };
}

describe('validateObservation', () => {
  it('accepts a well-formed observation', () => {
    expect(() => validateObservation(fixture())).not.toThrow();
  });

  it('rejects an empty scope', () => {
    expect(() => validateObservation(fixture({ scope: '' }))).toThrow(
      ObservationValidationError,
    );
  });

  it('rejects a non-UUID entity', () => {
    expect(() =>
      validateObservation(fixture({ entity: 'not-a-uuid' })),
    ).toThrow(ObservationValidationError);
  });

  it('rejects an unknown kind', () => {
    expect(() =>
      validateObservation(fixture({ kind: 'invent' as Observation['kind'] })),
    ).toThrow(ObservationValidationError);
  });

  it('rejects validTo before validFrom', () => {
    expect(() =>
      validateObservation(
        fixture({
          validFrom: new Date('2026-01-02T00:00:00Z'),
          validTo: new Date('2026-01-01T00:00:00Z'),
        }),
      ),
    ).toThrow(ObservationValidationError);
  });

  it('accepts a null validTo (current truth)', () => {
    expect(() =>
      validateObservation(fixture({ validTo: null })),
    ).not.toThrow();
  });

  it('rejects an empty author.sub', () => {
    expect(() =>
      validateObservation(
        fixture({ author: { sub: '', displayName: 'x' } }),
      ),
    ).toThrow(ObservationValidationError);
  });

  it('rejects parents entries that are not UUIDs', () => {
    expect(() =>
      validateObservation(
        fixture({ parents: ['not-a-uuid'] }),
      ),
    ).toThrow(ObservationValidationError);
  });

  it('error carries a machine-readable code', () => {
    try {
      validateObservation(fixture({ scope: '' }));
      throw new Error('should have thrown');
    } catch (err) {
      if (!(err instanceof ObservationValidationError)) throw err;
      expect(err.code).toBe('scope_required');
    }
  });
});
