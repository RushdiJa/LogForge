export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE log_minute_aggregates (
      bucket_start TIMESTAMPTZ NOT NULL,
      service TEXT NOT NULL,
      level log_level NOT NULL,
      count INTEGER NOT NULL,

      PRIMARY KEY (
        bucket_start,
        service,
        level
      )
    );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE log_minute_aggregates;
  `);
};