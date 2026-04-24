-- Landing-page customization columns on Organization. All optional
-- except landingShowPublicItems, which defaults to true so every
-- existing org gets a sensible landing page immediately without an
-- admin having to touch config.
ALTER TABLE "organization"
  ADD COLUMN "landing_title" TEXT,
  ADD COLUMN "landing_subtitle" TEXT,
  ADD COLUMN "landing_hero_image_url" TEXT,
  ADD COLUMN "landing_show_public_items" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "landing_featured_item_ids" UUID[] NOT NULL DEFAULT '{}'::uuid[];
