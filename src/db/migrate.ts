import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";

import type { Database } from "./client.js";

export async function applyMigrations(sql: Database): Promise<void> {
  await migrate(drizzle(sql), { migrationsFolder: "./migrations" });
}
