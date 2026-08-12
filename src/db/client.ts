import postgres, { type Sql } from "postgres";

export type Database = Sql;

export function createDatabase(databaseUrl: string): Database {
  return postgres(databaseUrl, {
    max: 6,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: true,
    transform: {
      undefined: null,
    },
  });
}
