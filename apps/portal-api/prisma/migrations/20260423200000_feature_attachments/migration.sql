-- Per-feature attachments for v3 feature-service layers. Metadata
-- only — bytes live in MinIO at storage_key.

-- CreateTable
CREATE TABLE "feature_attachment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "item_id" UUID NOT NULL,
    "layer_id" TEXT NOT NULL,
    "feature_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "storage_url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,

    CONSTRAINT "feature_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feature_attachment_item_id_layer_id_feature_id_idx"
  ON "feature_attachment"("item_id", "layer_id", "feature_id");

-- AddForeignKey
ALTER TABLE "feature_attachment"
  ADD CONSTRAINT "feature_attachment_item_id_fkey"
  FOREIGN KEY ("item_id") REFERENCES "item"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
