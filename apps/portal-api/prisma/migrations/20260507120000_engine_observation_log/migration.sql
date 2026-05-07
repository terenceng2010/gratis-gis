-- Phase 1 of the observation-log engine pivot. See
-- docs/architecture/observation-log-engine.md for the design.
--
-- Phase 1 deliberately ships without:
--   - pg_partman:   one default partition for now; monthly rotation
--                   arrives at Phase 2 cutover.
--   - pgh3:         cell strings are computed in app code via h3-js,
--                   so the column is just CHAR(15) here.
--   - pgvector:     embedding column omitted entirely; semantic search
--                   is a v2 deferred item.
--
-- The legacy feature_v3.* tables are NOT touched by this migration.
-- They keep working untouched; the engine grows alongside until the
-- Phase 2 cutover swaps the data_layer write/read paths over to it.

-- The observation log. One row per state change, append-only.
CREATE TABLE observation (
  id           UUID        PRIMARY KEY,
  tx_time      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_from   TIMESTAMPTZ NOT NULL,
  valid_to     TIMESTAMPTZ,
  scope        TEXT        NOT NULL,
  entity       UUID        NOT NULL,
  kind         TEXT        NOT NULL CHECK (
                 kind IN ('create','update','delete','derive','observe')
               ),
  attrs        JSONB,
  geom         GEOMETRY(Geometry, 4326),
  cell         CHAR(15),
  author_sub   TEXT        NOT NULL,
  source       JSONB       NOT NULL,
  parents      UUID[]      NOT NULL DEFAULT '{}'
) PARTITION BY RANGE (tx_time);

-- Single default partition for Phase 1. Phase 2 cutover replaces this
-- with monthly partitions managed by pg_partman.
CREATE TABLE observation_p_default PARTITION OF observation DEFAULT;

-- Spatial index over the geometry column. Used by the read path for
-- viewport, draw-region, and share-geo filters.
CREATE INDEX observation_geom_gix
  ON observation USING GIST (geom);

-- Primary lookup for "give me the current truth about an entity in a
-- scope": filter by (scope, entity), order by valid_from DESC, take 1.
-- The DESC ordering is what makes this index useful for currency reads.
CREATE INDEX observation_scope_entity_validfrom_idx
  ON observation (scope, entity, valid_from DESC);

-- Coarse spatial filter without evaluating geometry. Queries that know
-- the target H3 cell (e.g. "observations near here") hit this before
-- falling back to PostGIS.
CREATE INDEX observation_cell_idx
  ON observation (cell);

-- JSONB attribute search. `jsonb_path_ops` is more compact than the
-- default opclass and supports the operators we expect to use
-- (`?` existence, `@>` containment).
CREATE INDEX observation_attrs_gin
  ON observation USING GIN (attrs jsonb_path_ops);

-- Monotonic write index. Lets the read path scan recent observations
-- without first hitting the geometry or attribute indexes when the
-- filter is purely temporal.
CREATE INDEX observation_tx_time_idx
  ON observation (tx_time DESC);
