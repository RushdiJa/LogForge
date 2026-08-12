CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX "logs_message_trgm_idx" ON "logs" USING gin ("message" gin_trgm_ops);
