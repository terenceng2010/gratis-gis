-- Trigram index for attribute search over the observation log.
--
-- The map / app search bar searches feature attributes with
-- `attrs::text ILIKE '%q%'` (see DataLayerEngine.searchFeatures and
-- the attribute table's own search). Without a trigram index that is a
-- sequential scan over every current observation in the layer's scope.
-- On a large layer (the WV Parcels demo is ~1.4M rows) the scan is slow
-- enough that the search bar gives up and returns nothing, which reads
-- to a user as "attribute search is broken".
--
-- pg_trgm is already installed (see the init migration). This adds a
-- partial GIN trigram index over the text form of attrs, restricted to
-- current, non-deleted observations: exactly the rows the search query
-- ever scans (it always filters `valid_to IS NULL AND kind <> 'delete'`).
-- The partial predicate keeps the index small by excluding superseded
-- versions and tombstones.
--
-- The index is declared on the partitioned parent; Postgres propagates
-- it to every existing and future tx_time partition automatically, the
-- same way the engine's other observation indexes are declared (see the
-- partition_observation_table migration).
--
-- Note on deploy cost: this is a plain (non-CONCURRENT) index build.
-- CONCURRENTLY is not an option here because Prisma runs each migration
-- inside a transaction and Postgres does not support CONCURRENTLY on a
-- partitioned table anyway. On a large existing table the build takes an
-- ACCESS EXCLUSIVE lock on observation for the duration. It is a one-time
-- cost at deploy; on a multi-million-row table consider building it in a
-- maintenance window if write latency during deploy matters.
CREATE INDEX observation_attrs_trgm
  ON observation
  USING GIN ((attrs::text) gin_trgm_ops)
  WHERE valid_to IS NULL AND kind <> 'delete';
