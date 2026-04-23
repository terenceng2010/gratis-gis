-- Basemap registry — per-org custom basemaps that show up in the
-- web map editor's picker alongside the built-in set. Matches the
-- Basemap model in prisma/schema.prisma.

-- CreateEnum
CREATE TYPE "BasemapSourceKind" AS ENUM ('xyz', 'vector-style', 'wms');

-- CreateTable
CREATE TABLE "basemap" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL,
    "source_kind" "BasemapSourceKind" NOT NULL,
    "attribution" TEXT NOT NULL DEFAULT '',
    "thumbnail_url" TEXT,
    "config" JSONB,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,

    CONSTRAINT "basemap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "basemap_org_id_idx" ON "basemap"("org_id");

-- AddForeignKey
ALTER TABLE "basemap" ADD CONSTRAINT "basemap_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enforce at most one default basemap per org. NULL is_default=false
-- rows are allowed in any number; only one TRUE is permitted.
CREATE UNIQUE INDEX "basemap_one_default_per_org"
  ON "basemap"("org_id")
  WHERE "is_default" = true;
