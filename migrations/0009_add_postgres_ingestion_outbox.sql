CREATE TABLE "ingestion_batches" (
	"batch_id" uuid PRIMARY KEY,
	"payload" jsonb,
	"accepted_count" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_publish_attempt_at" timestamp (3) with time zone,
	"publish_attempts" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp (3) with time zone,
	"processed_at" timestamp (3) with time zone,
	"last_publish_error" text,
	CONSTRAINT "ingestion_batches_accepted_count_check"
		CHECK ("accepted_count" > 0),
	CONSTRAINT "ingestion_batches_payload_state_check"
		CHECK (
			("processed_at" IS NULL AND jsonb_typeof("payload") = 'array')
			OR ("processed_at" IS NOT NULL AND "payload" IS NULL)
		)
);

CREATE INDEX "ingestion_batches_pending_publish_idx"
	ON "ingestion_batches" ("last_publish_attempt_at" NULLS FIRST, "created_at", "batch_id")
	WHERE "processed_at" IS NULL;

CREATE INDEX "ingestion_batches_processed_at_idx"
	ON "ingestion_batches" ("processed_at")
	WHERE "processed_at" IS NOT NULL;
