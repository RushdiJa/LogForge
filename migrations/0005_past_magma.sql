CREATE TABLE "log_rollups_1h" (
	"bucket_start" timestamp (3) with time zone NOT NULL,
	"service" text NOT NULL,
	"level" "log_level" NOT NULL,
	"count" bigint NOT NULL,
	CONSTRAINT "log_rollups_1h_bucket_start_service_level_pk" PRIMARY KEY("bucket_start","service","level")
);
--> statement-breakpoint
CREATE TABLE "log_rollups_1s" (
	"bucket_start" timestamp (3) with time zone NOT NULL,
	"service" text NOT NULL,
	"level" "log_level" NOT NULL,
	"count" bigint NOT NULL,
	CONSTRAINT "log_rollups_1s_bucket_start_service_level_pk" PRIMARY KEY("bucket_start","service","level")
);
--> statement-breakpoint
DROP INDEX "logs_service_timestamp_id_idx";--> statement-breakpoint
CREATE INDEX "logs_service_level_timestamp_id_idx" ON "logs" USING btree ("service","level","timestamp" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint

INSERT INTO "log_rollups_1s" (
  "bucket_start",
  "service",
  "level",
  "count"
)
SELECT
  date_bin(
    INTERVAL '1 second',
    "timestamp",
    TIMESTAMPTZ '1970-01-01 00:00:00+00'
  ),
  "service",
  "level",
  count(*)::bigint
FROM "logs"
GROUP BY 1, 2, 3;--> statement-breakpoint

INSERT INTO "log_rollups_1h" (
  "bucket_start",
  "service",
  "level",
  "count"
)
SELECT
  date_bin(
    INTERVAL '1 hour',
    "timestamp",
    TIMESTAMPTZ '1970-01-01 00:00:00+00'
  ),
  "service",
  "level",
  count(*)::bigint
FROM "logs"
GROUP BY 1, 2, 3;--> statement-breakpoint

ALTER TABLE "log_rollups_1s" SET (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.01
);--> statement-breakpoint

ALTER TABLE "log_rollups_1h" SET (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.01
);
