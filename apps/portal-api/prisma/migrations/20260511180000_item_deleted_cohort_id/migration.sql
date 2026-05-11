-- #156 folder-cascade delete. When a folder is trashed with
-- cascade=true, every subfolder soft-deleted in the same operation
-- gets the same UUID stamped here so the restore path can bring
-- the whole cohort back together. Restoring a folder cohort-aware
-- means its childItemIds doesn't end up pointing at still-trashed
-- subfolders.

ALTER TABLE "item"
  ADD COLUMN "deleted_cohort_id" uuid;

CREATE INDEX "item_deleted_cohort_id_idx" ON "item" ("deleted_cohort_id");
