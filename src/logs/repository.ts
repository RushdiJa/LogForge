import { pool } from "../db.js";
import type { Log, FilterResult, AggregateBucket, AggregateFilterResult, AggregateResult } from "./type.js";

export async function insertLogBatch(logs: Log[]): Promise<void> {
  const rows: string[] = [];
  const values: unknown[] = [];

  for (let index = 0; index < logs.length; index++) {
    const log = logs[index]!;
    const base = index * 6;

    values.push(
      log.timestamp,
      log.level,
      log.service,
      log.message,
      Object.keys(log.attributes),
      Object.values(log.attributes)
    );

    rows.push(`(
      $${base + 1}, 
      $${base + 2},
      $${base + 3},
      $${base + 4},
      hstore($${base + 5}::text[], $${base + 6}::text[])
    )`);
  }

  await pool.query(`
    WITH inserted_logs AS (
      INSERT INTO logs (
        timestamp,
        level,
        service,
        message,
        attributes
      )
      VALUES ${rows.join(",")}
      RETURNING
        timestamp,
        service,
        level
    )
    INSERT INTO log_minute_aggregates (
      bucket_start,
      service,
      level,
      count
    )
    SELECT
      date_bin(
        '1 minute',
        timestamp,
        '1970-01-01T00:00:00Z'
      ),
      service,
      level,
      COUNT(*)::integer
    FROM inserted_logs
    GROUP BY
      1,
      service,
      level
    ON CONFLICT (
      bucket_start,
      service,
      level
    )
    DO UPDATE SET
      count =
        log_minute_aggregates.count +
        EXCLUDED.count
  `,
  values,
  );
}

export async function selectLogs(
  filter: FilterResult,
): Promise<(Log & {id: number})[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.service !== undefined) {
    values.push(filter.service);
    conditions.push(`l.service = $${values.length}`);
  }

  if (filter.level !== undefined) {
    values.push(filter.level);
    conditions.push(`l.level = $${values.length}`);
  }

  if (filter.since !== undefined) {
    values.push(filter.since);
    conditions.push(`l.timestamp >= $${values.length}`);
  }

  if (filter.until !== undefined) {
    values.push(filter.until);
    conditions.push(`l.timestamp < $${values.length}`);
  }

  if (filter.attributes !== undefined) {
    for (const [key, value] of Object.entries(filter.attributes)) {
      values.push(key);
      const keyParameter = `$${values.length}`;

      values.push(value);
      const valueParameter = `$${values.length}`;

      conditions.push(
        `(l.attributes -> ${keyParameter}) = ${valueParameter}`,
      );
    }
  }

  if (filter.q !== undefined) {
    const escapedQuery = filter.q.replace(/[\\%_]/g, "\\$&");

    values.push(`%${escapedQuery}%`);

    conditions.push(
      `l.message ILIKE $${values.length} ESCAPE '\\'`,
    );
  }

  if (filter.cursor !== undefined) {
    values.push(filter.cursor);

    conditions.push(`
      (l.timestamp, l.id) < (
        SELECT cursor_log.timestamp, cursor_log.id
        FROM logs AS cursor_log
        WHERE cursor_log.id = $${values.length}
      )
    `);
  }

  values.push(filter.limit);

  const result = await pool.query(
    `
      SELECT
        l.id,
        l.timestamp,
        l.level,
        l.service,
        l.message,
        hstore_to_json(l.attributes) AS attributes
      FROM logs AS l
      ${conditions.length > 0
        ? `WHERE ${conditions.join(" AND ")}`
        : ""}
      ORDER BY
        l.timestamp DESC,
        l.id DESC
      LIMIT $${values.length}
    `,
    values,
  );

  return result.rows as (Log & {id: number})[];
}


const bucketIntervals: Record<AggregateBucket, string> = {
  "1m": "1 minute",
  "5m": "5 minutes",
  "1h": "1 hour",
  "1d": "1 day",
};

export async function selectRawLogAggregates(
  filter: AggregateFilterResult,
): Promise<AggregateResult[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  values.push(bucketIntervals[filter.bucket]);
  const bucketParameter = `$${values.length}`;

  values.push(filter.since);
  conditions.push(`l.timestamp >= $${values.length}`);

  values.push(filter.until);
  conditions.push(`l.timestamp < $${values.length}`);

  if (filter.service !== undefined) {
    values.push(filter.service);
    conditions.push(`l.service = $${values.length}`);
  }

  if (filter.level !== undefined) {
    values.push(filter.level);
    conditions.push(`l.level = $${values.length}`);
  }

  if (filter.attributes !== undefined) {
    for (const [key, value] of Object.entries(filter.attributes)) {
      values.push(key);
      const keyParameter = `$${values.length}`;

      values.push(value);
      const valueParameter = `$${values.length}`;

      conditions.push(
        `(l.attributes -> ${keyParameter}) = ${valueParameter}`,
      );
    }
  }

  if (filter.q !== undefined) {
    const escapedQuery = filter.q.replace(/[\\%_]/g, "\\$&");

    values.push(`%${escapedQuery}%`);

    conditions.push(
      `l.message ILIKE $${values.length} ESCAPE '\\'`,
    );
  }

  let groupExpression = "NULL::text";

  if (filter.groupBy === "service") {
    groupExpression = "l.service";
  }

  if (filter.groupBy === "level") {
    groupExpression = "l.level::text";
  }

  const result = await pool.query(
    `
      SELECT
        date_bin(
          ${bucketParameter}::interval,
          l.timestamp,
          '1970-01-01T00:00:00Z'::timestamptz
        ) AS start,
          ${groupExpression} AS "group",
        COUNT(*)::integer AS count
      FROM logs AS l
      WHERE ${conditions.join(" AND ")}
      GROUP BY 1, 2
      ORDER BY 1 ASC, 2 ASC NULLS FIRST
    `,
    values,
  );

  return result.rows as AggregateResult[];
}

async function selectRollupLogAggregates(
  filter: AggregateFilterResult,
): Promise<AggregateResult[]> {
  const minuteMs = 60_000;

  const fullMinutesStart = new Date(
    Math.ceil(filter.since.getTime() / minuteMs) * minuteMs,
  );

  const fullMinutesEnd = new Date(
    Math.floor(filter.until.getTime() / minuteMs) * minuteMs,
  );

  // إذا لم توجد دقيقة كاملة، نستخدم السجلات الأصلية.
  if (fullMinutesStart >= fullMinutesEnd) {
    return selectRawLogAggregates(filter);
  }

  const values: unknown[] = [
    bucketIntervals[filter.bucket],
    filter.since,
    fullMinutesStart,
    fullMinutesEnd,
    filter.until,
  ];

  const rollupConditions = [
    `a.bucket_start >= $3`,
    `a.bucket_start < $4`,
  ];

  const boundaryConditions = [
    `(
      (l.timestamp >= $2 AND l.timestamp < $3)
      OR
      (l.timestamp >= $4 AND l.timestamp < $5)
    )`,
  ];

  if (filter.service !== undefined) {
    values.push(filter.service);
    const parameter = `$${values.length}`;

    rollupConditions.push(`a.service = ${parameter}`);
    boundaryConditions.push(`l.service = ${parameter}`);
  }

  if (filter.level !== undefined) {
    values.push(filter.level);
    const parameter = `$${values.length}`;

    rollupConditions.push(`a.level = ${parameter}`);
    boundaryConditions.push(`l.level = ${parameter}`);
  }

  let groupExpression = "NULL::text";

  if (filter.groupBy === "service") {
    groupExpression = "source.service";
  }

  if (filter.groupBy === "level") {
    groupExpression = "source.level::text";
  }

  const result = await pool.query(
    `
      WITH source AS (
        SELECT
          a.bucket_start AS timestamp,
          a.service,
          a.level,
          a.count
        FROM log_minute_aggregates AS a
        WHERE ${rollupConditions.join(" AND ")}

        UNION ALL

        SELECT
          l.timestamp,
          l.service,
          l.level,
          1 AS count
        FROM logs AS l
        WHERE ${boundaryConditions.join(" AND ")}
      )
      SELECT
        date_bin(
          $1::interval,
          source.timestamp,
          '1970-01-01T00:00:00Z'::timestamptz
        ) AS start,
        ${groupExpression} AS "group",
        SUM(source.count)::integer AS count
      FROM source
      GROUP BY 1, 2
      ORDER BY 1 ASC, 2 ASC NULLS FIRST
    `,
    values,
  );

  return result.rows as AggregateResult[];
}

export async function selectLogAggregates(
  filter: AggregateFilterResult,
): Promise<AggregateResult[]> {
  if (
    filter.q !== undefined ||
    filter.attributes !== undefined
  ) {
    return selectRawLogAggregates(filter);
  }

  return selectRollupLogAggregates(filter);
}