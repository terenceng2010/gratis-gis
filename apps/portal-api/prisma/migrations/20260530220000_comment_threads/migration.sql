-- #155 Threaded comments Phase 1. Adds CommentThread + Comment
-- tables and the CommentParentKind enum. The polymorphic
-- (parentKind, parentId) anchoring is in place from day one so
-- the Phase 2 feature- and drawing-anchored thread work doesn't
-- need a follow-up schema migration; today the controller writes
-- threads with parentKind = 'map' and parentId = itemId.

CREATE TYPE "CommentParentKind" AS ENUM ('map', 'layer', 'feature', 'drawing');

CREATE TABLE "comment_thread" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "item_id"     UUID NOT NULL,
  "parent_kind" "CommentParentKind" NOT NULL,
  "parent_id"   TEXT NOT NULL,
  "resolved"    BOOLEAN NOT NULL DEFAULT FALSE,
  "resolved_by" UUID,
  "resolved_at" TIMESTAMP(3),
  "created_by"  UUID NOT NULL,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "comment_thread_item_id_fkey" FOREIGN KEY ("item_id")
    REFERENCES "item"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "comment_thread_item_id_resolved_idx"
  ON "comment_thread" ("item_id", "resolved");
CREATE INDEX "comment_thread_parent_kind_parent_id_idx"
  ON "comment_thread" ("parent_kind", "parent_id");

CREATE TABLE "comment" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "thread_id"  UUID NOT NULL,
  "author_id"  UUID NOT NULL,
  "body"       TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "edited_at"  TIMESTAMP(3),
  CONSTRAINT "comment_thread_id_fkey" FOREIGN KEY ("thread_id")
    REFERENCES "comment_thread"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "comment_thread_id_created_at_idx"
  ON "comment" ("thread_id", "created_at");
