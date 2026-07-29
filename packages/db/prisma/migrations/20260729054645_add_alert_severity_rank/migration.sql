-- Numeric mirror of `severity` so the alert inbox can be ordered by urgency.
--
-- Ordering by the severity string sorts alphabetically — critical, info,
-- warning — which puts routine info notices above real warnings. Postgres
-- cannot express a custom order without raw SQL, banned in core, so the order
-- is stored.
--
-- The default is 1 (warning), matching the `severity` column's own default, so
-- a row written by anything that does not know about this column still lands in
-- a sane place rather than at the top of the inbox.
ALTER TABLE "alerts" ADD COLUMN     "severity_rank" INTEGER NOT NULL DEFAULT 1;

-- Backfill. Without this every pre-existing alert reads as a warning, which
-- would silently demote open criticals — the one class of alert that must not
-- be demoted — and promote infos above them.
UPDATE "alerts" SET "severity_rank" = CASE "severity"
  WHEN 'critical' THEN 0
  WHEN 'warning'  THEN 1
  WHEN 'info'     THEN 2
  ELSE 1
END;

-- Covers the inbox's own ordering: urgency first, then newest.
CREATE INDEX "alerts_status_severity_rank_created_at_idx" ON "alerts"("status", "severity_rank", "created_at");
