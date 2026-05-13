-- #66: per-item thumbnail design blob. Renderer lives in
-- packages/shared-types/src/thumbnail.ts; the SVG is computed on the
-- fly from this design + the row's current title and type, so a
-- rename automatically updates the thumbnail with no re-bake.
ALTER TABLE "item" ADD COLUMN "thumbnail_design" JSONB;
