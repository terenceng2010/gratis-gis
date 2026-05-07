// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Engine substrate types. The contract for what the observation log
// stores and what callers pass in. See
// `docs/architecture/observation-log-engine.md` for the design rationale.

/** GeoJSON geometry passed in or out of the engine. */
export type GeoJsonGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'MultiPoint'; coordinates: [number, number][] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'MultiLineString'; coordinates: [number, number][][] }
  | { type: 'Polygon'; coordinates: [number, number][][] }
  | { type: 'MultiPolygon'; coordinates: [number, number][][][] };

/**
 * The kind of state change an observation records.
 *
 * - `create`: the first observation about an entity.
 * - `update`: a subsequent assertion that supersedes prior values.
 * - `delete`: a tombstone. The entity is no longer asserted.
 * - `derive`: produced by computation, not by a user. `parents` lists the inputs.
 * - `observe`: a sensor or external measurement, not an edit to a curated dataset.
 */
export type ObservationKind = 'create' | 'update' | 'delete' | 'derive' | 'observe';

/**
 * Reference to the principal who authored an observation. The shape mirrors
 * what we already pull from a Keycloak JWT in `JwtAuthGuard` so engine writes
 * can flow straight from existing controllers.
 */
export interface PrincipalRef {
  /** JWT `sub` claim. Stable identifier for the user across sessions. */
  sub: string;
  /** Display name, denormalized for UX. May be empty for service principals. */
  displayName: string;
}

/**
 * Where an observation came from. Free-form JSONB on the wire so we do not
 * have to migrate the schema every time a new ingest source shows up.
 */
export interface SourceRef {
  /** A short tag describing the source kind. Examples: `web`, `field-app`,
   *  `arcgis-import`, `cron:housekeeping`, `script:backfill`. */
  kind: string;
  /** Optional free-form details. Device id, app version, ingest job id, etc. */
  details?: Record<string, unknown>;
}

/**
 * The unit of state in the engine. Every change to anything (a single
 * attribute edit, a whole layer creation, an import job, a derived row)
 * is one of these.
 *
 * On the wire (JSONB / Prisma layer), `id`, `txTime`, and `cell` are usually
 * filled in by `engine.write()`. Callers can supply them explicitly for tests
 * or for back-dated imports.
 */
export interface Observation {
  /** UUIDv7. Monotonically sortable. Filled by `engine.write()` if omitted. */
  id?: string;
  /** When the engine recorded this observation. Filled by `engine.write()`. */
  txTime?: Date;
  /** When the assertion is true in the world. Required. */
  validFrom: Date;
  /** When the assertion stops being true. `null` means current. */
  validTo: Date | null;
  /** The container this observation belongs to (e.g. `data_layer:abc123`). */
  scope: string;
  /** Stable id of the real-world thing this observation is about. UUIDv7. */
  entity: string;
  /** What kind of change this is. */
  kind: ObservationKind;
  /** Attribute payload. Schema depends on the scope. */
  attrs: Record<string, unknown> | null;
  /** Geometry, in EPSG:4326. */
  geom: GeoJsonGeometry | null;
  /** H3 cell (resolution 7) covering `geom`. Filled by `engine.write()`. */
  cell?: string | null;
  /** Who said this. */
  author: PrincipalRef;
  /** Where this came from. */
  source: SourceRef;
  /** Observation ids this row was derived from. Empty for user edits. */
  parents: string[];
}

/**
 * Read filter passed to `engine.read()`. Phase 1 supports the minimum needed
 * to round-trip a data_layer: filter by scope, optionally by an explicit
 * entity id, optionally as-of a moment in time.
 *
 * Wider filters (attribute predicates, geometry predicates, lens references)
 * land in later phases.
 */
export interface ReadQuery {
  /** Required. The scope to read from (e.g. `data_layer:abc123`). */
  scope: string;
  /** Optional. If set, only return observations for this entity id. */
  entity?: string;
  /** Optional. As-of moment for bitemporal reads. Defaults to `now`. */
  asOf?: Date;
  /** Optional. Cap on returned rows. Defaults to 1000. */
  limit?: number;
}

/**
 * GeoJSON Feature shape returned by `engine.read()`. Mirrors RFC 7946 with
 * the engine-specific bookkeeping fields tucked under `properties.__engine`
 * so callers that pass the Feature straight into MapLibre or any other
 * GeoJSON consumer do not see anything unfamiliar.
 */
export interface ReadFeature {
  type: 'Feature';
  /** The entity id, surfaced as the GeoJSON Feature `id`. */
  id: string;
  geometry: GeoJsonGeometry | null;
  properties: Record<string, unknown> & {
    __engine: {
      observationId: string;
      validFrom: string;
      validTo: string | null;
      txTime: string;
      kind: ObservationKind;
      authorSub: string;
    };
  };
}
