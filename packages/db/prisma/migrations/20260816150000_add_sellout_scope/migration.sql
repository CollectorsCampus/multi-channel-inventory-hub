-- What draftAtSellout applies to: "singles" (the default) or "all".
--
-- Defaulted to "singles" so every existing channel keeps the behaviour it has
-- today: sealed product is restocked far more often than a given card, and
-- unpublishing a booster box that will be back next week churns the storefront
-- for nothing when re-publishing is a manual step by design.
ALTER TABLE "channel_instances" ADD COLUMN "sellout_scope" TEXT NOT NULL DEFAULT 'singles';
