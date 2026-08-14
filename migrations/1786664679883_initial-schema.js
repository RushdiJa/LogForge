export const up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS hstore;

    CREATE TYPE log_level AS ENUM (
      'debug',
      'info',
      'warn',
      'error'
    );

    CREATE TABLE logs (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      timestamp TIMESTAMPTZ(3) NOT NULL,
      level log_level NOT NULL,
      service TEXT NOT NULL,
      message TEXT NOT NULL,
      attributes HSTORE NOT NULL
    );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE logs;
    DROP TYPE log_level;
  `);
};
