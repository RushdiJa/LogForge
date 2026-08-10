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
  postgres(databaseUrl);

export const db =
  drizzle(pg);