CREATE TYPE "public"."log_level" AS ENUM('debug', 'info', 'warn', 'error');--> statement-breakpoint
CREATE TABLE "logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"timestamp" timestamp (3) with time zone NOT NULL,
	"level" "log_level" NOT NULL,
	"service" text NOT NULL,
	"message" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ingested_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "logs_timestamp_id_idx"
ON "logs" ("timestamp" DESC, "id" DESC);

CREATE INDEX "logs_service_timestamp_id_idx"
ON "logs" ("service", "timestamp" DESC, "id" DESC);
