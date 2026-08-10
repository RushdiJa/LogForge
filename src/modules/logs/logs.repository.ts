import { db, pg } from "../../db/index.js";
import { logs } from "../../db/schema.js";
import { type Log , LogsError, type ParsedAggregateFilters, type ParsedLogsFilters} from "./logs.type.js";
import {
  and,
  desc,
  eq,
  gte,
  lt,
  type SQL,
  or,
  ilike,
  sql,
  asc
  
} from "drizzle-orm";

export type StoredLog = typeof logs.$inferSelect;

// export async function insertLog(log: Log) : Promise<void> {
//     try{
//         await db.insert(logs).values(log).execute();
//     }
//     catch(error : unknown){
//         throw new LogsError(
//             "LOGS_DATABASE_ERROR",
//             500,
//             "Could not insert log",
//         );
//     }
// }


function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}
function jsonbTextAttribute(key: string): SQL<string> {
  return sql<string>`jsonb_extract_path_text(${logs.attributes}, ${key})`;
}
export async function queryLogs(
  filters: ParsedLogsFilters,
): Promise<StoredLog[]> {
    const conditions: SQL[] = [];
    if (filters.service !== undefined) {
        conditions.push(
            eq(logs.service, filters.service),
        );
    }
    if (filters.level !== undefined) {
        conditions.push(
            eq(logs.level, filters.level),
        );
    }
    if (filters.since !== undefined) {
        conditions.push(
            gte(logs.timestamp, filters.since),
        );
    }

    if (filters.until !== undefined) {
        conditions.push(
            lt(logs.timestamp, filters.until),
        );
    }
    if (filters.q !== undefined) {
        const escapedQuery = escapeLike(filters.q);

        conditions.push(
            ilike(logs.message, `%${escapedQuery}%`),
        );
    }
    if (filters.cursor !== undefined) {
        conditions.push(
            or(
                lt(logs.timestamp, filters.cursor.timestamp),
                and(
                    eq(logs.timestamp, filters.cursor.timestamp),
                    lt(logs.id, filters.cursor.id),
                ),
            )!,
        );
    }
    if(filters.attributes !== undefined){
        for (const [key, value] of Object.entries(filters.attributes)) {
            conditions.push(
                eq(jsonbTextAttribute(key), value),
            );
        }
    }
    return db
    .select()
    .from(logs)
    .where(
        conditions.length > 0
        ? and(...conditions)
        : undefined,
    )
    .orderBy(
        desc(logs.timestamp),
        desc(logs.id),
    )
    .limit(filters.limit + 1);
}

export type AggregateRow = {
  start: Date;
  group: string | null;
  count: number;
};
function getBucketInterval(
  bucket: ParsedAggregateFilters["bucket"],
): SQL {
  switch (bucket) {
    case "1m":
      return sql`INTERVAL '1 minute'`;

    case "5m":
      return sql`INTERVAL '5 minutes'`;

    case "1h":
      return sql`INTERVAL '1 hour'`;

    case "1d":
      return sql`INTERVAL '1 day'`;
  }
}
export async function aggregateLogs(
  filters: ParsedAggregateFilters,
): Promise<AggregateRow[]> {
  const conditions: SQL[] = [
    // since inclusive
    gte(
      logs.timestamp,
      filters.since,
    ),

    // until exclusive
    lt(
      logs.timestamp,
      filters.until,
    ),
  ];

  if (filters.service !== undefined) {
    conditions.push(
      eq(
        logs.service,
        filters.service,
      ),
    );
  }

  if (filters.level !== undefined) {
    conditions.push(
      eq(
        logs.level,
        filters.level,
      ),
    );
  }

  /*
   * Empty q matches everything anyway.
   * Avoid evaluating ILIKE '%%' for every row.
   */
  if (
    filters.q !== undefined &&
    filters.q.length > 0
  ) {
    conditions.push(
      ilike(
        logs.message,
        `%${escapeLike(filters.q)}%`,
      ),
    );
  }

  /*
   * Avoid Object.entries() allocation.
   */
  for (const key in filters.attributes) {
    conditions.push(
      eq(
        jsonbTextAttribute(key),
        filters.attributes[key]!,
      ),
    );
  }

  const whereCondition =
    and(...conditions);

  const interval =
    getBucketInterval(
      filters.bucket,
    );

  const bucketStart = sql<Date>`
    date_bin(
      ${interval},
      ${logs.timestamp},
      TIMESTAMPTZ '1970-01-01 00:00:00+00'
    )
  `;

  const count =
    sql<number>`count(*)::int`;

  switch (filters.group_by) {
    case "service":
      return db
        .select({
          start: bucketStart,
          group: logs.service,
          count,
        })
        .from(logs)
        .where(whereCondition)
        .groupBy(
          bucketStart,
          logs.service,
        )
        .orderBy(
          asc(bucketStart),
          asc(logs.service),
        );

    case "level":
      return db
        .select({
          start: bucketStart,
          group: logs.level,
          count,
        })
        .from(logs)
        .where(whereCondition)
        .groupBy(
          bucketStart,
          logs.level,
        )
        .orderBy(
          asc(bucketStart),
          asc(logs.level),
        );

    default:
      return db
        .select({
          start: bucketStart,
          group: sql<null>`NULL`,
          count,
        })
        .from(logs)
        .where(whereCondition)
        .groupBy(bucketStart)
        .orderBy(
          asc(bucketStart),
        );
  }
}

export async function insertLogsBatch(
  logsToInsert: Log[],
): Promise<void> {
  if (logsToInsert.length === 0) {
    return;
  }

  const timestamps: string[] =
    new Array(logsToInsert.length);

  const levels: string[] =
    new Array(logsToInsert.length);

  const services: string[] =
    new Array(logsToInsert.length);

  const messages: string[] =
    new Array(logsToInsert.length);

  const attributes: string[] =
    new Array(logsToInsert.length);

  for (
    let index = 0;
    index < logsToInsert.length;
    index++
  ) {
    const log = logsToInsert[index]!;

    timestamps[index] =
      log.timestamp.toISOString();

    levels[index] =
      log.level;

    services[index] =
      log.service;

    messages[index] =
      log.message;

    attributes[index] =
      JSON.stringify(
        log.attributes ?? {},
      );
  }

  await pg`
    INSERT INTO logs (
      timestamp,
      level,
      service,
      message,
      attributes
    )
    SELECT
      timestamp,
      level,
      service,
      message,
      attributes
    FROM unnest(
      ${pg.array(timestamps)}::timestamptz[],
      ${pg.array(levels)}::log_level[],
      ${pg.array(services)}::text[],
      ${pg.array(messages)}::text[],
      ${pg.array(attributes)}::jsonb[]
    ) AS input(
      timestamp,
      level,
      service,
      message,
      attributes
    )
  `;
}