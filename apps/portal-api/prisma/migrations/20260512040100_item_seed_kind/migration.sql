-- #22 seed_kind column on item. Stamps a stable identifier on items
-- seeded from a built-in starter (e.g. 'sidebar-explorer') so the
-- admin "Restore starter templates" flow can cheaply check whether
-- an org already has a given starter without scanning content. Null
-- for any user-authored template or non-starter item.

ALTER TABLE "item" ADD COLUMN "seed_kind" TEXT;

-- Non-partial composite index matching the Prisma schema declaration
-- (@@index([orgId, type, seedKind])). Most rows will have a null
-- seed_kind so the index still stays small in practice; the bootstrap
-- lookup ("does this org already own a starter with this seedKind?")
-- becomes a 3-column index scan that returns at most a handful of
-- rows per org.
CREATE INDEX "item_org_type_seed_kind_idx"
  ON "item" ("org_id", "type", "seed_kind");
