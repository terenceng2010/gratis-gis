-- #83: decouple read vs edit row scope on item_share. Until now
-- `row_scope` applied to BOTH reads and writes, so a share at
-- rowScope='own' meant the grantee could see only their own rows
-- AND edit only their own rows. The pairing covers the common case
-- but blocks see-all/edit-own which is a real field-data pattern
-- (surveyors want context but shouldn't edit a neighbor's capture).
--
-- New column `edit_row_scope` is nullable. NULL = inherit from
-- `row_scope` (preserves pre-#83 behavior for every existing row;
-- no backfill needed). When non-null, `row_scope` becomes the
-- read scope and `edit_row_scope` is the write scope.

ALTER TABLE "item_share"
  ADD COLUMN "edit_row_scope" "ShareRowScope";
