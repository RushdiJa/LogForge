DO $$
DECLARE
	partition_start bigint;
BEGIN
	LOCK TABLE "logs" IN ACCESS EXCLUSIVE MODE;
	SELECT nextval(pg_get_serial_sequence('logs', 'id')) INTO partition_start;

	ALTER TABLE "logs" RENAME TO "logs_legacy";
	ALTER TABLE "logs_legacy" RENAME CONSTRAINT "logs_pkey" TO "logs_legacy_pkey";
	ALTER INDEX "logs_timestamp_id_idx" RENAME TO "logs_legacy_timestamp_id_idx";
	ALTER INDEX "logs_service_level_timestamp_id_idx" RENAME TO "logs_legacy_service_level_timestamp_id_idx";
	ALTER INDEX "logs_message_trgm_idx" RENAME TO "logs_legacy_message_trgm_idx";
	ALTER INDEX "logs_legacy_message_trgm_idx" RESET (gin_pending_list_limit);

	CREATE TABLE "logs" (
		LIKE "logs_legacy" INCLUDING DEFAULTS INCLUDING STORAGE INCLUDING COMMENTS
	) PARTITION BY RANGE ("id");
	ALTER TABLE "logs" ADD CONSTRAINT "logs_pkey" PRIMARY KEY ("id");
	CREATE INDEX "logs_timestamp_id_idx"
		ON ONLY "logs" ("timestamp" DESC NULLS LAST, "id" DESC NULLS LAST);
	CREATE INDEX "logs_service_level_timestamp_id_idx"
		ON ONLY "logs" ("service", "level", "timestamp" DESC NULLS LAST, "id" DESC NULLS LAST);
	CREATE INDEX "logs_message_trgm_idx"
		ON ONLY "logs" USING gin ("message" gin_trgm_ops);

	EXECUTE format(
		'ALTER TABLE "logs_legacy" ADD CONSTRAINT "logs_legacy_id_partition_check" CHECK ("id" < %s)',
		partition_start
	);
	EXECUTE format(
		'ALTER TABLE "logs" ATTACH PARTITION "logs_legacy" FOR VALUES FROM (MINVALUE) TO (%s)',
		partition_start
	);
	EXECUTE format(
		'CREATE TABLE "logs_hot" PARTITION OF "logs" FOR VALUES FROM (%s) TO (MAXVALUE)',
		partition_start
	);
	ALTER TABLE "logs_hot" SET (autovacuum_vacuum_insert_threshold = 5000000);
END
$$;
