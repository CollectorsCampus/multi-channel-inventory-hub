-- Repricing: latest market prices per (item, source, printing), the review
-- queue for large moves, and the per-channel policy column.

ALTER TABLE "channel_instances" ADD COLUMN "repricing_policy" TEXT NOT NULL DEFAULT '{}';

CREATE TABLE "market_prices" (
    "id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "printing" TEXT NOT NULL DEFAULT 'NORMAL',
    "price" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "previous_price" INTEGER,
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_prices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "market_prices_catalog_item_id_source_printing_key" ON "market_prices"("catalog_item_id", "source", "printing");

ALTER TABLE "market_prices" ADD CONSTRAINT "market_prices_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "catalog_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "reprice_proposals" (
    "id" TEXT NOT NULL,
    "allocation_id" TEXT NOT NULL,
    "current_price" INTEGER,
    "proposed_price" INTEGER NOT NULL,
    "market_price" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reprice_proposals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reprice_proposals_allocation_id_key" ON "reprice_proposals"("allocation_id");

ALTER TABLE "reprice_proposals" ADD CONSTRAINT "reprice_proposals_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "channel_allocations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
