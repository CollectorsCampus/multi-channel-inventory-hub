-- Publishing a listing again when stock returns, for channels that ask for it.
--
-- Off by default, separately from draft_at_sellout: leaving a sold-out page up
-- costs nothing, while publishing something the operator deliberately held back
-- is a decision they never made.
ALTER TABLE "channel_instances" ADD COLUMN "reactivate_on_restock" BOOLEAN NOT NULL DEFAULT false;

-- The permission slip. A platform cannot say who drafted a product, so this is
-- the only honest answer to "was this listing ours to re-publish". Null for
-- every existing row, which is correct: nothing drafted before this migration
-- can be attributed to the hub, so none of it is re-published automatically.
ALTER TABLE "channel_allocations" ADD COLUMN "sellout_drafted_at" TIMESTAMP(3);
