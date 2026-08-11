import {
  asc,
  inArray,
  lt,
} from "drizzle-orm";

import { db } from "../../db/index.js";
import { pg } from "../../db/index.js";
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

/*
 * Remove expired rollups and rebuild the boundary buckets that straddle
 * the exact retention cutoff. Rebuilding from finer rollups avoids a large
 * raw-table scan for the boundary hour.
 */
export async function pruneExpiredLogRollups(
  cutoff: Date,
): Promise<void> {
  const cutoffIso = cutoff.toISOString();

  await pg.begin(async (transaction) => {
    await transaction`
      DELETE FROM log_rollups_1s
      WHERE bucket_start <= date_trunc(
        'second',
        ${cutoffIso}::timestamptz
      )
    `;

    await transaction`
      INSERT INTO log_rollups_1s (
        bucket_start,
        service,
        level,
        count
      )
      SELECT
        date_trunc('second', timestamp),
        service,
        level,
        count(*)::bigint
      FROM logs
      WHERE
        timestamp >= date_trunc(
          'second',
          ${cutoffIso}::timestamptz
        )
        AND timestamp < date_trunc(
          'second',
          ${cutoffIso}::timestamptz
        ) + INTERVAL '1 second'
      GROUP BY 1, 2, 3
      ON CONFLICT (bucket_start, service, level)
      DO UPDATE SET count = EXCLUDED.count
    `;

    await transaction`
      DELETE FROM log_rollups_1m
      WHERE bucket_start <= date_trunc(
        'minute',
        ${cutoffIso}::timestamptz
      )
    `;

    await transaction`
      INSERT INTO log_rollups_1m (
        bucket_start,
        service,
        level,
        count
      )
      SELECT
        date_trunc('minute', bucket_start),
        service,
        level,
        sum(count)::bigint
      FROM log_rollups_1s
      WHERE
        bucket_start >= date_trunc(
          'minute',
          ${cutoffIso}::timestamptz
        )
        AND bucket_start < date_trunc(
          'minute',
          ${cutoffIso}::timestamptz
        ) + INTERVAL '1 minute'
      GROUP BY 1, 2, 3
      ON CONFLICT (bucket_start, service, level)
      DO UPDATE SET count = EXCLUDED.count
    `;

    await transaction`
      DELETE FROM log_rollups_1h
      WHERE bucket_start <= date_trunc(
        'hour',
        ${cutoffIso}::timestamptz
      )
    `;

    await transaction`
      INSERT INTO log_rollups_1h (
        bucket_start,
        service,
        level,
        count
      )
      SELECT
        date_trunc('hour', bucket_start),
        service,
        level,
        sum(count)::bigint
      FROM log_rollups_1m
      WHERE
        bucket_start >= date_trunc(
          'hour',
          ${cutoffIso}::timestamptz
        )
        AND bucket_start < date_trunc(
          'hour',
          ${cutoffIso}::timestamptz
        ) + INTERVAL '1 hour'
      GROUP BY 1, 2, 3
      ON CONFLICT (bucket_start, service, level)
      DO UPDATE SET count = EXCLUDED.count
    `;
  });
}
