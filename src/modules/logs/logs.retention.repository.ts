import {
  asc,
  inArray,
  lt,
} from "drizzle-orm";

import { db } from "../../db/index.js";
import { logs } from "../../db/schema.js";

const RETENTION_BATCH_SIZE = 5_000;

export async function deleteExpiredLogsBatch(
  cutoff: Date,
): Promise<number> {
  const expiredLogs = db
    .select({
      id: logs.id,
    })
    .from(logs)
    .where(
      lt(logs.timestamp, cutoff),
    )
    .orderBy(
      asc(logs.timestamp),
      asc(logs.id),
    )
    .limit(RETENTION_BATCH_SIZE);

  const deletedLogs = await db
    .delete(logs)
    .where(
      inArray(logs.id, expiredLogs),
    )
    .returning({
      id: logs.id,
    });

  return deletedLogs.length;
}