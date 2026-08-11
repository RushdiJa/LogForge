CREATE TABLE "log_rollups_1m" (
    "bucket_start" timestamp (3) with time zone NOT NULL,
    "service" text NOT NULL,
    "level" "log_level" NOT NULL,
    "count" bigint NOT NULL,
    CONSTRAINT "log_rollups_1m_bucket_start_service_level_pk"
        PRIMARY KEY ("bucket_start", "service", "level")
);

CREATE TABLE "log_rollup_progress" (
    "name" text PRIMARY KEY,
    "last_log_id" bigint NOT NULL
);

INSERT INTO "log_rollup_progress" (
    "name",
    "last_log_id"
)
VALUES (
    '1m',
    0
);

CREATE OR REPLACE FUNCTION process_log_rollups()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    current_last_id bigint;
    next_last_id bigint;
BEGIN
    SELECT last_log_id
    INTO current_last_id
    FROM log_rollup_progress
    WHERE name = '1m'
    FOR UPDATE;

    SELECT MAX(id)
    INTO next_last_id
    FROM (
        SELECT id
        FROM logs
        WHERE id > current_last_id
        ORDER BY id
        LIMIT 10000
    ) AS batch;

    IF next_last_id IS NULL THEN
        RETURN;
    END IF;

    INSERT INTO log_rollups_1m (
        bucket_start,
        service,
        level,
        count
    )
    SELECT
        date_bin(
            INTERVAL '1 minute',
            timestamp,
            TIMESTAMPTZ '1970-01-01 00:00:00+00'
        ),
        service,
        level,
        COUNT(*)::bigint
    FROM logs
    WHERE id > current_last_id
      AND id <= next_last_id
    GROUP BY
        1,
        service,
        level
    ON CONFLICT (
        bucket_start,
        service,
        level
    )
    DO UPDATE
    SET count =
        log_rollups_1m.count
        + EXCLUDED.count;

    UPDATE log_rollup_progress
    SET last_log_id = next_last_id
    WHERE name = '1m';
END;
$$;