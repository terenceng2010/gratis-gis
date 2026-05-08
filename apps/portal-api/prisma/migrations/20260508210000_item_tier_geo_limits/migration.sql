-- #80: tier-level geo limits for the public + org access tiers.
--
-- shareGeoLimit only attaches to per-user / per-group ItemShare rows,
-- so a data_layer marked access='public' has no place to hang a
-- polygon clip; the public tier is all-or-nothing today. Same gap
-- exists at access='org'. Add two optional FK columns on `item`
-- pointing at a geo_boundary item: when set, the read-path predicate
-- composer intersects the boundary into the predicate stack for
-- viewers landing through the matching access tier.
--
-- We intentionally do not add database FKs to `item` for the same
-- reason the existing item_share.geo_boundary_id doesn't: `item` is
-- polymorphic across every item type (geo_boundary, basemap, map…)
-- and Postgres can't enforce "FK + type check" cleanly without a
-- trigger. The read path dereferences the id at request time and
-- treats a missing / wrong-typed / deleted target as "no clip" so a
-- broken reference cannot silently widen access.

ALTER TABLE "item"
  ADD COLUMN "public_geo_boundary_id" UUID,
  ADD COLUMN "org_geo_boundary_id"    UUID;

CREATE INDEX "item_public_geo_boundary_id_idx"
  ON "item"("public_geo_boundary_id");

CREATE INDEX "item_org_geo_boundary_id_idx"
  ON "item"("org_geo_boundary_id");
