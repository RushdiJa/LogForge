import { sql } from "drizzle-orm";

import { db } from "../../db/index.js";

export async function checkHealth(): Promise<{ ready: boolean }> {
  try {
    await db.execute(sql`select 1`);
    return {
      ready: true,
    };
  } catch {
    return {
      ready: false,
    };
  }
}