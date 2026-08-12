-- Restore with:
-- CREATE INDEX CONCURRENTLY "logs_level_timestamp_id_idx"
-- ON "logs" ("level", "timestamp" DESC NULLS LAST, "id" DESC NULLS LAST);
DROP INDEX IF EXISTS "logs_level_timestamp_id_idx";
