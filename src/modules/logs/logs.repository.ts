import { pg, writePg } from "../../db/index.js";
import { logs } from "../../db/schema.js";

import type {
  Log,
  ParsedAggregateFilters,
  ParsedLogsFilters,
} from "./logs.type.js";

export type StoredLog = typeof logs.$inferSelect;

export type AggregateRow = {
  start: Date;
  group: string | null;
  count: number;
};

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
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

  const since = filters.since?.toISOString();
  const until = filters.until?.toISOString();
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
          ? pg`AND service = ${filters.service}`
          : pg``
      }
      ${
        filters.level !== undefined
          ? pg`AND level = ${filters.level}::log_level`
          : pg``
      }
      ${
        since !== undefined
          ? pg`AND timestamp >= ${since}::timestamptz`
          : pg``
      }
      ${
        until !== undefined
          ? pg`AND timestamp < ${until}::timestamptz`
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
    ORDER BY timestamp DESC, id DESC
    LIMIT ${filters.limit + 1}
  `;

  return rows.map((row) => ({
    id: Number(row.id),
    timestamp: new Date(row.timestamp as string),
    level: row.level,
    service: row.service,
    message: row.message,
    attributes: row.attributes,
  })) as StoredLog[];
}

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

function mapAggregateRows(
  rows: Record<string, unknown>[],
): AggregateRow[] {
  return rows.map((row) => ({
    start: new Date(row.start as string),
    group:
      row.group === null
        ? null
        : String(row.group),
    count: Number(row.count),
  }));
}

/*
 * q and arbitrary attribute equality cannot be represented by the
 * service/level rollup. Those combinations intentionally use the
 * raw table so every API filter remains correct.
 */
async function aggregateRawLogs(
  filters: ParsedAggregateFilters,
): Promise<AggregateRow[]> {
  const since = filters.since.toISOString();
  const until = filters.until.toISOString();
  const interval = getRawBucketInterval(filters.bucket);

  let attributeConditions = pg``;

  for (const key in filters.attributes) {
    const value = filters.attributes[key]!;

    attributeConditions = pg`
      ${attributeConditions}
      AND attributes ->> ${key} = ${value}
    `;
  }

  const groupExpression =
    filters.group_by === "service"
      ? pg`service`
      : filters.group_by === "level"
        ? pg`level::text`
        : pg`NULL::text`;

  const groupBySuffix =
    filters.group_by === undefined
      ? pg``
      : pg`, 2`;

  const orderBySuffix =
    filters.group_by === undefined
      ? pg``
      : pg`, 2 ASC`;

  const rows = await pg`
    SELECT
      date_bin(
        ${interval},
        timestamp,
        TIMESTAMPTZ '1970-01-01 00:00:00+00'
      ) AS start,
      ${groupExpression} AS "group",
      count(*)::bigint AS count
    FROM logs
    WHERE
      timestamp >= ${since}::timestamptz
      AND timestamp < ${until}::timestamptz
      ${
        filters.service !== undefined
          ? pg`AND service = ${filters.service}`
          : pg``
      }
      ${
        filters.level !== undefined
          ? pg`AND level = ${filters.level}::log_level`
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
      ${attributeConditions}
    GROUP BY 1 ${groupBySuffix}
    ORDER BY 1 ASC ${orderBySuffix}
  `;

  return mapAggregateRows(rows);
}

/*
 * Select the coarsest rollup that cannot change the requested output:
 *
 * - 1h/1d buckets use complete hour rollups;
 * - 1m/5m buckets start with complete minute rollups;
 * - boundary minutes use complete second rollups;
 * - only the two partial boundary seconds touch raw logs.
 *
 * This preserves exact inclusive-since/exclusive-until behavior without
 * scanning the hot current minute during sustained ingestion.
 */
async function aggregateRolledUpLogs(
  filters: ParsedAggregateFilters,
): Promise<AggregateRow[]> {
  const secondMs = 1_000;
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;

  const useHourRollups =
    filters.bucket === "1h" ||
    filters.bucket === "1d";

  const fullSecondStart = new Date(
    Math.ceil(filters.since.getTime() / secondMs) * secondMs,
  ).toISOString();

  const fullSecondEnd = new Date(
    Math.floor(filters.until.getTime() / secondMs) * secondMs,
  ).toISOString();

  const fullMinuteStart = new Date(
    Math.ceil(filters.since.getTime() / minuteMs) * minuteMs,
  ).toISOString();

  const fullMinuteEnd = new Date(
    Math.floor(filters.until.getTime() / minuteMs) * minuteMs,
  ).toISOString();

  const fullHourStart = new Date(
    Math.ceil(filters.since.getTime() / hourMs) * hourMs,
  ).toISOString();

  const fullHourEnd = new Date(
    Math.floor(filters.until.getTime() / hourMs) * hourMs,
  ).toISOString();

  const since = filters.since.toISOString();
  const until = filters.until.toISOString();
  const interval = getRawBucketInterval(filters.bucket);

  const groupExpression =
    filters.group_by === "service"
      ? pg`service`
      : filters.group_by === "level"
        ? pg`level::text`
        : pg`NULL::text`;

  const groupBySuffix =
    filters.group_by === undefined
      ? pg``
      : pg`, 2`;

  const orderBySuffix =
    filters.group_by === undefined
      ? pg``
      : pg`, 2 ASC`;

  const serviceCondition =
    filters.service !== undefined
      ? pg`AND service = ${filters.service}`
      : pg``;

  const levelCondition =
    filters.level !== undefined
      ? pg`AND level = ${filters.level}::log_level`
      : pg``;

  const hourSource = useHourRollups
    ? pg`
        SELECT
          bucket_start AS timestamp,
          service,
          level,
          count
        FROM log_rollups_1h
        WHERE
          bucket_start >= ${fullHourStart}::timestamptz
          AND bucket_start < ${fullHourEnd}::timestamptz
          ${serviceCondition}
          ${levelCondition}

        UNION ALL
      `
    : pg``;

  const outsideCompleteHours = useHourRollups
    ? pg`
        AND (
          bucket_start < ${fullHourStart}::timestamptz
          OR bucket_start >= ${fullHourEnd}::timestamptz
        )
      `
    : pg``;

  const rows = await pg`
    WITH source AS MATERIALIZED (
      ${hourSource}

      SELECT
        bucket_start AS timestamp,
        service,
        level,
        count
      FROM log_rollups_1m
      WHERE
        bucket_start >= ${fullMinuteStart}::timestamptz
        AND bucket_start < ${fullMinuteEnd}::timestamptz
        ${outsideCompleteHours}
        ${serviceCondition}
        ${levelCondition}

      UNION ALL

      SELECT
        bucket_start AS timestamp,
        service,
        level,
        count
      FROM log_rollups_1s
      WHERE
        bucket_start >= ${fullSecondStart}::timestamptz
        AND bucket_start < ${fullSecondEnd}::timestamptz
        AND (
          bucket_start < ${fullMinuteStart}::timestamptz
          OR bucket_start >= ${fullMinuteEnd}::timestamptz
        )
        ${serviceCondition}
        ${levelCondition}

      UNION ALL

      SELECT
        timestamp,
        service,
        level,
        1::bigint AS count
      FROM logs
      WHERE
        timestamp >= ${since}::timestamptz
        AND timestamp < ${until}::timestamptz
        AND (
          timestamp < ${fullSecondStart}::timestamptz
          OR timestamp >= ${fullSecondEnd}::timestamptz
        )
        ${serviceCondition}
        ${levelCondition}
    )
    SELECT
      date_bin(
        ${interval},
        timestamp,
        TIMESTAMPTZ '1970-01-01 00:00:00+00'
      ) AS start,
      ${groupExpression} AS "group",
      sum(count)::bigint AS count
    FROM source
    GROUP BY 1 ${groupBySuffix}
    ORDER BY 1 ASC ${orderBySuffix}
  `;

  return mapAggregateRows(rows);
}

export async function aggregateLogs(
  filters: ParsedAggregateFilters,
): Promise<AggregateRow[]> {
  const requiresRawLogs =
    (filters.q !== undefined && filters.q.length > 0) ||
    Object.keys(filters.attributes).length > 0;

  return requiresRawLogs
    ? aggregateRawLogs(filters)
    : aggregateRolledUpLogs(filters);
}

export async function insertLogsBatch(
  logsToInsert: Log[],
): Promise<void> {
  if (logsToInsert.length === 0) {
    return;
  }

  const timestamps = new Array<string>(logsToInsert.length);
  const levels = new Array<string>(logsToInsert.length);
  const services = new Array<string>(logsToInsert.length);
  const messages = new Array<string>(logsToInsert.length);
  const attributes = new Array<string>(logsToInsert.length);

  for (
    let index = 0;
    index < logsToInsert.length;
    index++
  ) {
    const log = logsToInsert[index]!;

    timestamps[index] = log.timestamp.toISOString();
    levels[index] = log.level;
    services[index] = log.service;
    messages[index] = log.message;
    attributes[index] = JSON.stringify(log.attributes ?? {});
  }

  /*
   * One statement and one commit persist both the raw logs and their
   * second/minute/hour counts. UNNEST avoids thousands of SQL parameters,
   * while aggregating each batch keeps rollup updates small.
   */
  await writePg`
    WITH inserted AS MATERIALIZED (
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
        ${writePg.array(timestamps)}::timestamptz[],
        ${writePg.array(levels)}::log_level[],
        ${writePg.array(services)}::text[],
        ${writePg.array(messages)}::text[],
        ${writePg.array(attributes)}::jsonb[]
      ) AS input(
        timestamp,
        level,
        service,
        message,
        attributes
      )
      RETURNING timestamp, service, level
    ),
    batch_counts_1s AS (
      SELECT
        date_bin(
          INTERVAL '1 second',
          timestamp,
          TIMESTAMPTZ '1970-01-01 00:00:00+00'
        ) AS bucket_start,
        service,
        level,
        count(*)::bigint AS count
      FROM inserted
      GROUP BY 1, 2, 3
    ),
    upsert_1s AS (
      INSERT INTO log_rollups_1s (
        bucket_start,
        service,
        level,
        count
      )
      SELECT
        bucket_start,
        service,
        level,
        count
      FROM batch_counts_1s
      ON CONFLICT (bucket_start, service, level)
      DO UPDATE SET
        count = log_rollups_1s.count + EXCLUDED.count
      RETURNING 1
    ),
    batch_counts AS (
      SELECT
        date_bin(
          INTERVAL '1 minute',
          timestamp,
          TIMESTAMPTZ '1970-01-01 00:00:00+00'
        ) AS bucket_start,
        service,
        level,
        count(*)::bigint AS count
      FROM inserted
      GROUP BY 1, 2, 3
    ),
    upsert_1m AS (
      INSERT INTO log_rollups_1m (
        bucket_start,
        service,
        level,
        count
      )
      SELECT
        bucket_start,
        service,
        level,
        count
      FROM batch_counts
      ON CONFLICT (bucket_start, service, level)
      DO UPDATE SET
        count = log_rollups_1m.count + EXCLUDED.count
      RETURNING 1
    ),
    batch_counts_1h AS (
      SELECT
        date_bin(
          INTERVAL '1 hour',
          timestamp,
          TIMESTAMPTZ '1970-01-01 00:00:00+00'
        ) AS bucket_start,
        service,
        level,
        count(*)::bigint AS count
      FROM inserted
      GROUP BY 1, 2, 3
    )
    INSERT INTO log_rollups_1h (
      bucket_start,
      service,
      level,
      count
    )
    SELECT
      bucket_start,
      service,
      level,
      count
    FROM batch_counts_1h
    ON CONFLICT (bucket_start, service, level)
    DO UPDATE SET
      count = log_rollups_1h.count + EXCLUDED.count
  `;
}
