-- The printed collector number, where a source publishes one. Nullable, no
-- unique: numbers are unique only within a set and set names diverge between
-- sources. Exists for duplicate detection — the strongest cross-source signal
-- that two catalog items are one product — and is backfilled by re-ingesting,
-- not by this migration, since only the sources know the values.
ALTER TABLE "catalog_items" ADD COLUMN "collector_number" TEXT;
