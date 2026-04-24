-- Open-data license field on items. See docs / DCAT catalog at
-- /public/catalog.json for how this is surfaced to downstream
-- consumers. Null = no license recorded; consumers should assume
-- "rights reserved" until the owner sets one explicitly.
ALTER TABLE "item"
  ADD COLUMN "license" TEXT;
