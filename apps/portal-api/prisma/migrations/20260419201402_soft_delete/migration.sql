-- AlterTable
ALTER TABLE "group" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "item" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "group_deleted_at_idx" ON "group"("deleted_at");

-- CreateIndex
CREATE INDEX "item_deleted_at_idx" ON "item"("deleted_at");
