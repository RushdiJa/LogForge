import type { Database } from "../../../db/client.js";
import { toIsoTimestamp } from "../../../shared/timestamp.js";
import { addParameter, buildWhere } from "../logs.repository.js";
import type { AggregateBucket, AggregateQuery, Bucket } from "./aggregate.type.js";

const BUCKET_INTERVALS: Record<Bucket, string> = {
  "1m": "1 minute",
  "5m": "5 minutes",
  "1h": "1 hour",
  "1d": "1 day",
};

interface AggregateRow {
  start: Date | string;
  group_value: string | null;
  count: string;
}

function isMinuteAligned(timestamp: string): boolean {
  return Date.parse(timestamp) % 60_000 === 0;
}

export class AggregateRepository {
  constructor(private readonly sql: Database) {}

  async aggregate(query: AggregateQuery): Promise<AggregateBucket[]> {
    const canUseRollup =
      query.q === undefined &&
      Object.keys(query.attributes).length === 0 &&
      isMinuteAligned(query.since) &&
      isMinuteAligned(query.until);

    const rows = canUseRollup
      ? await this.aggregateRollups(query)
      : await this.aggregateRawLogs(query);

    return rows.map((row) => ({
      start: toIsoTimestamp(row.start),
      group: row.group_value,
      count: Number(row.count),
    }));
  }

  private async aggregateRollups(query: AggregateQuery): Promise<AggregateRow[]> {
    const parameters: (string | number | boolean | null)[] = [];
    const add = (value: string | number | boolean | null): string => {
      parameters.push(value);
      return `$${parameters.length}`;
    };
    const interval = add(BUCKET_INTERVALS[query.bucket]);
    const since = add(query.since);
    const until = add(query.until);
    const conditions = [`r.bucket_start >= ${since}::timestamptz`, `r.bucket_start < ${until}::timestamptz`];

    if (query.service !== undefined) {
      conditions.push(`r.service = ${add(query.service)}`);
    }
    if (query.level !== undefined) {
      conditions.push(`r.level = ${add(query.level)}::log_level`);
    }

    const groupExpression =
      query.groupBy === "service"
        ? "r.service"
        : query.groupBy === "level"
          ? "r.level::text"
          : "NULL::text";

    return this.sql.unsafe<AggregateRow[]>(
      `SELECT date_bin(${interval}::interval, r.bucket_start, TIMESTAMPTZ '1970-01-01') AS start,
              ${groupExpression} AS group_value,
              SUM(r.count)::text AS count
       FROM log_rollups_1m r
       WHERE ${conditions.join(" AND ")}
       GROUP BY 1, 2
       ORDER BY 1 ASC, 2 ASC NULLS FIRST`,
      parameters,
    );
  }

  private async aggregateRawLogs(query: AggregateQuery): Promise<AggregateRow[]> {
    const where = buildWhere(query);
    const intervalParameter = addParameter(where, BUCKET_INTERVALS[query.bucket]);
    const groupExpression =
      query.groupBy === "service"
        ? "l.service"
        : query.groupBy === "level"
          ? "l.level::text"
          : "NULL::text";

    return this.sql.unsafe<AggregateRow[]>(
      `SELECT date_bin(${intervalParameter}::interval, l.timestamp, TIMESTAMPTZ '1970-01-01') AS start,
              ${groupExpression} AS group_value,
              COUNT(*)::text AS count
       FROM logs l
       WHERE ${where.text}
       GROUP BY 1, 2
       ORDER BY 1 ASC, 2 ASC NULLS FIRST`,
      where.parameters,
    );
  }
}
