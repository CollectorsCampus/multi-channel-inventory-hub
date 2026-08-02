-- AlterTable
ALTER TABLE "channel_instances" ADD COLUMN     "auto_list_new_stock" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "listing_defaults" TEXT NOT NULL DEFAULT '{}';
