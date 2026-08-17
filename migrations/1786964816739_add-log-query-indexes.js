export const up = (pgm) => {
  pgm.sql(`
    CREATE INDEX logs_timestamp_id_idx
    ON logs (timestamp DESC, id DESC);

    CREATE INDEX logs_service_timestamp_id_idx
    ON logs (service, timestamp DESC, id DESC);

    CREATE INDEX logs_level_timestamp_id_idx
    ON logs (level, timestamp DESC, id DESC);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS logs_level_timestamp_id_idx;
    DROP INDEX IF EXISTS logs_service_timestamp_id_idx;
    DROP INDEX IF EXISTS logs_timestamp_id_idx;
  `);
};