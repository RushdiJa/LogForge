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
  let attributeConditions = pg``;

  for (const key in filters.attributes) {
    const value = filters.attributes[key]!;

    attributeConditions = pg`
      ${attributeConditions}
      AND attributes ->> ${key} = ${value}
    `;
  }

  const since =
    filters.since?.toISOString();

  const until =
    filters.until?.toISOString();

  const cursorTimestamp =
    filters.cursor?.timestamp.toISOString();

  const rows = await pg`
    SELECT
      id,
      timestamp,
      level,
      service,
      message,
      attributes
    FROM logs
    WHERE TRUE

    ${
      filters.service !== undefined
        ? pg`
            AND service = ${filters.service}
          `
        : pg``
    }

    ${
      filters.level !== undefined
        ? pg`
            AND level = ${filters.level}::log_level
          `
        : pg``
    }

    ${
      since !== undefined
        ? pg`
            AND timestamp >= ${since}::timestamptz
          `
        : pg``
    }

    ${
      until !== undefined
        ? pg`
            AND timestamp < ${until}::timestamptz
          `
        : pg``
    }

    ${
      filters.q !== undefined &&
      filters.q.length > 0
        ? pg`
            AND message ILIKE ${
              `%${escapeLike(filters.q)}%`
            }
          `
        : pg``
    }

    ${
      filters.cursor !== undefined &&
      cursorTimestamp !== undefined
        ? pg`
            AND (
              timestamp < ${cursorTimestamp}::timestamptz
              OR (
                timestamp = ${cursorTimestamp}::timestamptz
                AND id < ${filters.cursor.id}
              )
            )
          `
        : pg``
    }

    ${attributeConditions}

    ORDER BY
      timestamp DESC,
      id DESC

    LIMIT ${filters.limit + 1}
  `;

  return rows.map((row) => ({
    id: Number(row.id),
    timestamp: new Date(
      row.timestamp as string,
    ),
    level: row.level,
    service: row.service,
    message: row.message,
    attributes: row.attributes,
  })) as StoredLog[];
}

export type AggregateRow = {
  start: Date;
  group: string | null;
  count: number;
};
function getRawBucketInterval(
  bucket: ParsedAggregateFilters["bucket"],
) {
  switch (bucket) {
    case "1m":
      return pg`INTERVAL '1 minute'`;

    case "5m":
      return pg`INTERVAL '5 minutes'`;

    case "1h":
      return pg`INTERVAL '1 hour'`;

    case "1d":
      return pg`INTERVAL '1 day'`;
  }
}

export async function aggregateRawLogs(
  filters: ParsedAggregateFilters,
): Promise<AggregateRow[]> {
  const since = filters.since.toISOString();
  const until = filters.until.toISOString();

  const interval =
    getRawBucketInterval(filters.bucket);

  let attributeConditions = pg``;

  for (const key in filters.attributes) {
    const value =
      filters.attributes[key]!;

    attributeConditions = pg`
      ${attributeConditions}
      AND attributes ->> ${key} = ${value}
    `;
  }

  const serviceCondition =
    filters.service !== undefined
      ? pg`
          AND service = ${filters.service}
        `
      : pg``;

  const levelCondition =
    filters.level !== undefined
      ? pg`
          AND level = ${filters.level}::log_level
        `
      : pg``;

  const queryCondition =
    filters.q !== undefined &&
    filters.q.length > 0
      ? pg`
          AND message ILIKE ${
            `%${escapeLike(filters.q)}%`
          }
        `
      : pg``;

  /*
   * GROUP BY service
   */
  if (filters.group_by === "service") {
    const rows = await pg`
      SELECT
        date_bin(
          ${interval},
          timestamp,
          TIMESTAMPTZ '1970-01-01 00:00:00+00'
        ) AS start,

        service AS "group",

        count(*)::int AS count

      FROM logs

      WHERE
        timestamp >= ${since}::timestamptz
        AND timestamp < ${until}::timestamptz

        ${serviceCondition}
        ${levelCondition}
        ${queryCondition}
        ${attributeConditions}

      GROUP BY
        1,
        service

      ORDER BY
        1 ASC,
        service ASC
    `;

    return rows.map((row) => ({
      start: new Date(
        row.start as string,
      ),
      group: row.group as string,
      count: Number(row.count),
    }));
  }

  /*
   * GROUP BY level
   */
  if (filters.group_by === "level") {
    const rows = await pg`
      SELECT
        date_bin(
          ${interval},
          timestamp,
          TIMESTAMPTZ '1970-01-01 00:00:00+00'
        ) AS start,

        level AS "group",

        count(*)::int AS count

      FROM logs

      WHERE
        timestamp >= ${since}::timestamptz
        AND timestamp < ${until}::timestamptz

        ${serviceCondition}
        ${levelCondition}
        ${queryCondition}
        ${attributeConditions}

      GROUP BY
        1,
        level

      ORDER BY
        1 ASC,
        level ASC
    `;

    return rows.map((row) => ({
      start: new Date(
        row.start as string,
      ),
      group: row.group as string,
      count: Number(row.count),
    }));
  }

  /*
   * No grouping
   */
  const rows = await pg`
    SELECT
      date_bin(
        ${interval},
        timestamp,
        TIMESTAMPTZ '1970-01-01 00:00:00+00'
      ) AS start,

      NULL::text AS "group",

      count(*)::int AS count

    FROM logs

    WHERE
      timestamp >= ${since}::timestamptz
      AND timestamp < ${until}::timestamptz

      ${serviceCondition}
      ${levelCondition}
      ${queryCondition}
      ${attributeConditions}

    GROUP BY
      1

    ORDER BY
      1 ASC
  `;

  return rows.map((row) => ({
    start: new Date(
      row.start as string,
    ),
    group: null,
    count: Number(row.count),
  }));
}
export async function aggregateLogs(
  filters: ParsedAggregateFilters,
): Promise<AggregateRow[]> {
  if (
    (filters.q !== undefined &&
      filters.q.length > 0) ||
    Object.keys(filters.attributes).length > 0
  ) {
    return aggregateRawLogs(filters);
  }

  const since =
    filters.since.toISOString();

  const until =
    filters.until.toISOString();

  const interval =
    getRawBucketInterval(filters.bucket);

  const minuteMs = 60_000;

  const fullMinuteStart =
    new Date(
      Math.ceil(
        filters.since.getTime() /
          minuteMs,
      ) * minuteMs,
    ).toISOString();

  const fullMinuteEnd =
    new Date(
      Math.floor(
        filters.until.getTime() /
          minuteMs,
      ) * minuteMs,
    ).toISOString();

  const rollupServiceCondition =
    filters.service !== undefined
      ? pg`
          AND service = ${filters.service}
        `
      : pg``;

  const rollupLevelCondition =
    filters.level !== undefined
      ? pg`
          AND level = ${filters.level}::log_level
        `
      : pg``;

  const rawServiceCondition =
    filters.service !== undefined
      ? pg`
          AND logs.service = ${filters.service}
        `
      : pg``;

  const rawLevelCondition =
    filters.level !== undefined
      ? pg`
          AND logs.level = ${filters.level}::log_level
        `
      : pg``;

  /*
   * GROUP BY service
   */
  if (filters.group_by === "service") {
    const rows = await pg`
      WITH progress AS (
        SELECT
          COALESCE(
            (
              SELECT last_log_id
              FROM log_rollup_progress
              WHERE name = '1m'
            ),
            0
          )::bigint AS last_log_id
      ),

      source AS (
        SELECT
          bucket_start AS timestamp,
          service,
          count
        FROM log_rollups_1m
        WHERE
          bucket_start >= ${fullMinuteStart}::timestamptz
          AND bucket_start < ${fullMinuteEnd}::timestamptz

          ${rollupServiceCondition}
          ${rollupLevelCondition}

        UNION ALL

        SELECT
          logs.timestamp,
          logs.service,
          1::bigint AS count
        FROM logs
        CROSS JOIN progress
        WHERE
          logs.timestamp >= ${since}::timestamptz
          AND logs.timestamp < ${until}::timestamptz

          AND (
            logs.id > progress.last_log_id

            OR logs.timestamp <
              ${fullMinuteStart}::timestamptz

            OR logs.timestamp >=
              ${fullMinuteEnd}::timestamptz
          )

          ${rawServiceCondition}
          ${rawLevelCondition}
      )

      SELECT
        date_bin(
          ${interval},
          timestamp,
          TIMESTAMPTZ '1970-01-01 00:00:00+00'
        ) AS start,

        service AS "group",

        SUM(count)::bigint AS count

      FROM source

      GROUP BY
        1,
        service

      ORDER BY
        1 ASC,
        service ASC
    `;

    return rows.map((row) => ({
      start: new Date(
        row.start as string,
      ),
      group: row.group as string,
      count: Number(row.count),
    }));
  }

  /*
   * GROUP BY level
   */
  if (filters.group_by === "level") {
    const rows = await pg`
      WITH progress AS (
        SELECT
          COALESCE(
            (
              SELECT last_log_id
              FROM log_rollup_progress
              WHERE name = '1m'
            ),
            0
          )::bigint AS last_log_id
      ),

      source AS (
        SELECT
          bucket_start AS timestamp,
          level,
          count
        FROM log_rollups_1m
        WHERE
          bucket_start >= ${fullMinuteStart}::timestamptz
          AND bucket_start < ${fullMinuteEnd}::timestamptz

          ${rollupServiceCondition}
          ${rollupLevelCondition}

        UNION ALL

        SELECT
          logs.timestamp,
          logs.level,
          1::bigint AS count
        FROM logs
        CROSS JOIN progress
        WHERE
          logs.timestamp >= ${since}::timestamptz
          AND logs.timestamp < ${until}::timestamptz

          AND (
            logs.id > progress.last_log_id

            OR logs.timestamp <
              ${fullMinuteStart}::timestamptz

            OR logs.timestamp >=
              ${fullMinuteEnd}::timestamptz
          )

          ${rawServiceCondition}
          ${rawLevelCondition}
      )

      SELECT
        date_bin(
          ${interval},
          timestamp,
          TIMESTAMPTZ '1970-01-01 00:00:00+00'
        ) AS start,

        level::text AS "group",

        SUM(count)::bigint AS count

      FROM source

      GROUP BY
        1,
        level

      ORDER BY
        1 ASC,
        level ASC
    `;

    return rows.map((row) => ({
      start: new Date(
        row.start as string,
      ),
      group: row.group as string,
      count: Number(row.count),
    }));
  }

  /*
   * No grouping
   */
  const rows = await pg`
    WITH progress AS (
      SELECT
        COALESCE(
          (
            SELECT last_log_id
            FROM log_rollup_progress
            WHERE name = '1m'
          ),
          0
        )::bigint AS last_log_id
    ),

    source AS (
      SELECT
        bucket_start AS timestamp,
        count
      FROM log_rollups_1m
      WHERE
        bucket_start >= ${fullMinuteStart}::timestamptz
        AND bucket_start < ${fullMinuteEnd}::timestamptz

        ${rollupServiceCondition}
        ${rollupLevelCondition}

      UNION ALL

      SELECT
        logs.timestamp,
        1::bigint AS count
      FROM logs
      CROSS JOIN progress
      WHERE
        logs.timestamp >= ${since}::timestamptz
        AND logs.timestamp < ${until}::timestamptz

        AND (
          logs.id > progress.last_log_id

          OR logs.timestamp <
            ${fullMinuteStart}::timestamptz

          OR logs.timestamp >=
            ${fullMinuteEnd}::timestamptz
        )

        ${rawServiceCondition}
        ${rawLevelCondition}
    )

    SELECT
      date_bin(
        ${interval},
        timestamp,
        TIMESTAMPTZ '1970-01-01 00:00:00+00'
      ) AS start,

      NULL::text AS "group",

      SUM(count)::bigint AS count

    FROM source

    GROUP BY
      1

    ORDER BY
      1 ASC
  `;

  return rows.map((row) => ({
    start: new Date(
      row.start as string,
    ),
    group: null,
    count: Number(row.count),
  }));
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