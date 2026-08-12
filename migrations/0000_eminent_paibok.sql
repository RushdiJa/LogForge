CREATE TYPE "public"."log_level" AS ENUM('debug', 'info', 'warn', 'error');--> statement-breakpoint
CREATE TABLE "log_rollups_1m" (
	"bucket_start" timestamp (0) with time zone NOT NULL,
	"service" text NOT NULL,
	"level" "log_level" NOT NULL,
	"count" bigint NOT NULL,
	CONSTRAINT "log_rollups_1m_bucket_start_service_level_pk" PRIMARY KEY("bucket_start","service","level")
);
--> statement-breakpoint
CREATE TABLE "logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"timestamp" timestamp (3) with time zone NOT NULL,
	"level" "log_level" NOT NULL,
	"service" text NOT NULL,
	"message" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ingested_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "logs_timestamp_id_idx" ON "logs" USING btree ("timestamp" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "logs_service_level_timestamp_id_idx" ON "logs" USING btree ("service","level","timestamp" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "logs_level_timestamp_id_idx" ON "logs" USING btree ("level","timestamp" DESC NULLS LAST,"id" DESC NULLS LAST);
