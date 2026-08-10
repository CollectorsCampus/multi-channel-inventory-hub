-- Opt-in per channel: draft a single's product when its quantity is pushed to
-- zero and the platform shows the whole product out of stock.
ALTER TABLE "channel_instances" ADD COLUMN "draft_at_sellout" BOOLEAN NOT NULL DEFAULT false;
