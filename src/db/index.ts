import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

const databaseUrl =
  process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required",
  );
}

export const pg =
  postgres(databaseUrl, {
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
  });

/*
 * Keep ingestion on its own connection so slow read queries
 * cannot occupy every connection and starve the write worker.
 */
export const writePg =
  postgres(databaseUrl, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });

/*
 * Health checks have a dedicated lightweight connection. This
 * prevents a busy read pool from making a healthy service look
 * unavailable during the load test.
 */
export const healthPg =
  postgres(databaseUrl, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });

export const db =
  drizzle(pg);

export async function closeDatabasePools(): Promise<void> {
  await Promise.all([
    pg.end({ timeout: 5 }),
    writePg.end({ timeout: 5 }),
    healthPg.end({ timeout: 5 }),
  ]);
}
