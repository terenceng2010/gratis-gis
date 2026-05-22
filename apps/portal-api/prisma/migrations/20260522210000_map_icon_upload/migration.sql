-- User-uploaded SVG marker icons for the map point-symbol
-- picker (#73). One row per upload; layer styles reference a
-- row by storage_key (PointStyle.iconName = 'upload:<key>').

CREATE TABLE IF NOT EXISTS "map_icon_upload" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "storage_key" TEXT         NOT NULL,
  "storage_url" TEXT         NOT NULL,
  "label"       TEXT         NOT NULL,
  "file_name"   TEXT         NOT NULL,
  "size_bytes"  INTEGER      NOT NULL,
  "org_id"      UUID         NOT NULL,
  "created_by"  UUID         NOT NULL,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "map_icon_upload_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "map_icon_upload_org_created_idx"
  ON "map_icon_upload" ("org_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "map_icon_upload_user_created_idx"
  ON "map_icon_upload" ("created_by", "created_at" DESC);
