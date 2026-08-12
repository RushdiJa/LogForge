DO $$
DECLARE
	current_bound text;
	lower_bound bigint;
	partition_start bigint;
BEGIN
	IF to_regclass('logs_hot_archive') IS NULL THEN
		LOCK TABLE "logs" IN ACCESS EXCLUSIVE MODE;
		SELECT nextval('logs_id_seq'::regclass) INTO partition_start;
		SELECT pg_get_expr(relpartbound, oid)
		INTO current_bound
		FROM pg_class
		WHERE relname = 'logs_hot';
		lower_bound := ((regexp_match(current_bound, '[0-9]+'))[1])::bigint;

		ALTER TABLE "logs" DETACH PARTITION "logs_hot";
		ALTER TABLE "logs_hot" RENAME TO "logs_hot_archive";
		ALTER TABLE "logs_hot_archive" RENAME CONSTRAINT "logs_hot_pkey"
			TO "logs_hot_archive_pkey";
		ALTER INDEX "logs_hot_timestamp_id_idx"
			RENAME TO "logs_hot_archive_timestamp_id_idx";
		ALTER INDEX "logs_hot_service_level_timestamp_id_idx"
			RENAME TO "logs_hot_archive_service_level_timestamp_id_idx";
		ALTER INDEX "logs_hot_message_fingerprint_idx"
			RENAME TO "logs_hot_archive_message_fingerprint_idx";

		EXECUTE format(
			'ALTER TABLE "logs_hot_archive" ADD CONSTRAINT "logs_hot_archive_id_partition_check" CHECK ("id" >= %s AND "id" < %s)',
			lower_bound,
			partition_start
		);
		EXECUTE format(
			'ALTER TABLE "logs" ATTACH PARTITION "logs_hot_archive" FOR VALUES FROM (%s) TO (%s)',
			lower_bound,
			partition_start
		);
		EXECUTE format(
			'CREATE TABLE "logs_hot" PARTITION OF "logs" FOR VALUES FROM (%s) TO (MAXVALUE)',
			partition_start
		);
		ALTER TABLE "logs_hot" SET (autovacuum_vacuum_insert_threshold = 5000000);
		CREATE INDEX "logs_hot_message_fingerprint_idx"
			ON "logs_hot" (hashtextextended("message", 0));
	END IF;
END
$$;
