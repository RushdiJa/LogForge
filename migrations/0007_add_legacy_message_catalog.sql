CREATE TABLE IF NOT EXISTS "log_legacy_message_search" (
	"message" text PRIMARY KEY
);

INSERT INTO "log_legacy_message_search" ("message")
SELECT DISTINCT "message" FROM "logs_legacy"
ON CONFLICT ("message") DO NOTHING;

CREATE INDEX IF NOT EXISTS "log_legacy_message_search_trgm_idx"
	ON "log_legacy_message_search" USING gin ("message" gin_trgm_ops);
