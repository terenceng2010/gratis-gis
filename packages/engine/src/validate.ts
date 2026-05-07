// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Observation validation. The engine refuses to accept malformed
// observations on the write path; this is the single source of truth for
// what "malformed" means. Keeping the rules in one file makes them easy to
// extend without spelunking through controllers.

import type { Observation, ObservationKind } from './types.js';
import { isUuid } from './uuid.js';

const VALID_KINDS: ReadonlyArray<ObservationKind> = [
  'create',
  'update',
  'delete',
  'derive',
  'observe',
];

export class ObservationValidationError extends Error {
  constructor(
    message: string,
    /** A short machine-readable code so callers can branch on cause. */
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ObservationValidationError';
  }
}

/**
 * Validate an Observation before insertion. Throws
 * `ObservationValidationError` on the first problem. This is intentionally
 * not a "collect all errors" pass; the caller is expected to fix one issue,
 * resubmit, and learn the next.
 *
 * Fields the engine fills in itself (`id`, `txTime`, `cell`) are not
 * required at this stage.
 */
export function validateObservation(obs: Observation): void {
  if (typeof obs.scope !== 'string' || obs.scope.length === 0) {
    throw new ObservationValidationError(
      'scope must be a non-empty string',
      'scope_required',
    );
  }
  if (!isUuid(obs.entity)) {
    throw new ObservationValidationError(
      'entity must be a UUIDv7-shaped string',
      'entity_invalid',
    );
  }
  if (!VALID_KINDS.includes(obs.kind)) {
    throw new ObservationValidationError(
      `kind must be one of ${VALID_KINDS.join(', ')}`,
      'kind_invalid',
    );
  }
  if (!(obs.validFrom instanceof Date) || Number.isNaN(obs.validFrom.getTime())) {
    throw new ObservationValidationError(
      'validFrom must be a valid Date',
      'valid_from_invalid',
    );
  }
  if (
    obs.validTo !== null &&
    (!(obs.validTo instanceof Date) || Number.isNaN(obs.validTo.getTime()))
  ) {
    throw new ObservationValidationError(
      'validTo must be a valid Date or null',
      'valid_to_invalid',
    );
  }
  if (obs.validTo !== null && obs.validTo <= obs.validFrom) {
    throw new ObservationValidationError(
      'validTo must be strictly after validFrom',
      'valid_range_invalid',
    );
  }
  if (typeof obs.author?.sub !== 'string' || obs.author.sub.length === 0) {
    throw new ObservationValidationError(
      'author.sub must be a non-empty string',
      'author_required',
    );
  }
  if (typeof obs.source?.kind !== 'string' || obs.source.kind.length === 0) {
    throw new ObservationValidationError(
      'source.kind must be a non-empty string',
      'source_required',
    );
  }
  if (!Array.isArray(obs.parents)) {
    throw new ObservationValidationError(
      'parents must be an array (possibly empty)',
      'parents_invalid',
    );
  }
  for (const p of obs.parents) {
    if (!isUuid(p)) {
      throw new ObservationValidationError(
        `parents entry "${p}" is not a UUID`,
        'parents_invalid',
      );
    }
  }
  // attrs and geom are explicitly nullable. Everything else is structural.
}
