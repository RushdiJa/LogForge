CREATE TABLE IF NOT EXISTS "log_hot_archive_message_search" (
	"message" text PRIMARY KEY
);

INSERT INTO "log_hot_archive_message_search" ("message")
SELECT DISTINCT "message" FROM "logs_hot_archive"
ON CONFLICT ("message") DO NOTHING;

CREATE INDEX IF NOT EXISTS "log_hot_archive_message_search_trgm_idx"
	ON "log_hot_archive_message_search" USING gin ("message" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "logs_hot_archive_message_trgm_idx"
	ON "logs_hot_archive" USING gin ("message" gin_trgm_ops);
