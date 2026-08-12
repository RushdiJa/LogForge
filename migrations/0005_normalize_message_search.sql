CREATE TABLE IF NOT EXISTS "log_message_search" (
	"message" text PRIMARY KEY
);

INSERT INTO "log_message_search" ("message")
SELECT DISTINCT "message" FROM "logs"
ON CONFLICT ("message") DO NOTHING;

CREATE INDEX IF NOT EXISTS "log_message_search_trgm_idx"
	ON "log_message_search" USING gin ("message" gin_trgm_ops);

DO $$
DECLARE
	legacy_bound text;
BEGIN
	IF to_regclass('logs_hot_message_fingerprint_idx') IS NULL THEN
		CREATE INDEX "logs_hot_message_fingerprint_idx"
			ON "logs_hot" (hashtextextended("message", 0));
	END IF;

	IF to_regclass('logs_message_hash_idx') IS NOT NULL THEN
		DROP INDEX "logs_message_hash_idx";
	END IF;

	IF to_regclass('logs_message_trgm_idx') IS NOT NULL THEN
		SELECT pg_get_expr(relpartbound, oid)
		INTO legacy_bound
		FROM pg_class
		WHERE relname = 'logs_legacy';

		ALTER TABLE "logs" DETACH PARTITION "logs_legacy";
		DROP INDEX "logs_message_trgm_idx";
		EXECUTE 'ALTER TABLE "logs" ATTACH PARTITION "logs_legacy" ' || legacy_bound;
	END IF;
END
$$;
