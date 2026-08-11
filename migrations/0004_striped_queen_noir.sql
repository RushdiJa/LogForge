CREATE TABLE IF NOT EXISTS "log_rollups_1m" (
	"bucket_start" timestamp (3) with time zone NOT NULL,
	"service" text NOT NULL,
	"level" "log_level" NOT NULL,
	"count" bigint NOT NULL,
	CONSTRAINT "log_rollups_1m_bucket_start_service_level_pk" PRIMARY KEY("bucket_start","service","level")
);
--> statement-breakpoint
DROP INDEX IF EXISTS "logs_service_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "logs_level_timestamp_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "logs_message_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "logs_timestamp_id_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "logs_service_timestamp_id_idx" ON "logs" USING btree ("service","timestamp" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "logs_timestamp_id_idx" ON "logs" USING btree ("timestamp" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint

ALTER SEQUENCE "logs_id_seq" CACHE 1000;--> statement-breakpoint

DROP FUNCTION IF EXISTS process_log_rollups();--> statement-breakpoint
DROP TABLE IF EXISTS "log_rollup_progress";--> statement-breakpoint

TRUNCATE TABLE "log_rollups_1m";--> statement-breakpoint

INSERT INTO "log_rollups_1m" (
  "bucket_start",
  "service",
  "level",
  "count"
)
SELECT
  date_bin(
    INTERVAL '1 minute',
    "timestamp",
    TIMESTAMPTZ '1970-01-01 00:00:00+00'
  ),
  "service",
  "level",
  count(*)::bigint
FROM "logs"
GROUP BY 1, 2, 3;--> statement-breakpoint

ALTER TABLE "log_rollups_1m" SET (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.01
);
