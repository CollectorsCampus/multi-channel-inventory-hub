-- AlterTable
ALTER TABLE "catalog_items" ADD COLUMN     "search_name" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "catalog_items_search_name_idx" ON "catalog_items"("search_name");
