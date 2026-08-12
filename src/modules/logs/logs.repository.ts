import type { Database } from "../../db/client.js";
import { toIsoTimestamp } from "../../shared/timestamp.js";
import type {
  AcceptedLog,
  LogAttributes,
  LogFilters,
  LogQuery,
  LogLevel,
  StoredLog,
} from "./logs.type.js";

interface StoredLogRow {
  id: string;
  timestamp: Date | string;
  level: LogLevel;
  service: string;
  message: string;
  attributes: LogAttributes;
}

interface SqlQuery {
  text: string;
  parameters: (string | number | boolean | null)[];
}

function addParameter(query: SqlQuery, value: string | number | boolean | null): string {
  query.parameters.push(value);
  return `$${query.parameters.length}`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function buildWhere(filters: LogFilters & { cursor?: LogQuery["cursor"] }, tableAlias = "l"): SqlQuery {
  const query: SqlQuery = { text: "", parameters: [] };
  const conditions: string[] = [];

  if (filters.service !== undefined) {
    conditions.push(`${tableAlias}.service = ${addParameter(query, filters.service)}`);
  }
  if (filters.level !== undefined) {
    conditions.push(`${tableAlias}.level = ${addParameter(query, filters.level)}::log_level`);
  }
  if (filters.since !== undefined) {
    conditions.push(`${tableAlias}.timestamp >= ${addParameter(query, filters.since)}::timestamptz`);
  }
  if (filters.until !== undefined) {
    conditions.push(`${tableAlias}.timestamp < ${addParameter(query, filters.until)}::timestamptz`);
  }
  if (filters.q !== undefined) {
    conditions.push(`${tableAlias}.message ILIKE ${addParameter(query, `%${escapeLike(filters.q)}%`)} ESCAPE '\\'`);
  }
  for (const [key, value] of Object.entries(filters.attributes)) {
    const keyParameter = addParameter(query, key);
    const valueParameter = addParameter(query, value);
    conditions.push(`${tableAlias}.attributes ->> ${keyParameter} = ${valueParameter}`);
  }
  if (filters.cursor !== undefined) {
    const timestampParameter = addParameter(query, filters.cursor.timestamp);
    const idParameter = addParameter(query, filters.cursor.id);
    conditions.push(
      `(${tableAlias}.timestamp, ${tableAlias}.id) < (${timestampParameter}::timestamptz, ${idParameter}::bigint)`,
    );
  }

  query.text = conditions.length === 0 ? "TRUE" : conditions.join(" AND ");
  return query;
}

export class LogsRepository {
  constructor(private readonly sql: Database) {}

  async insertBatch(logs: AcceptedLog[]): Promise<void> {
    if (logs.length === 0) {
      return;
    }

    const timestamps = new Array<string>(logs.length);
    const levels = new Array<LogLevel>(logs.length);
    const services = new Array<string>(logs.length);
    const messages = new Array<string>(logs.length);
    const attributes = new Array<string>(logs.length);

    for (let index = 0; index < logs.length; index += 1) {
      const log = logs[index] as AcceptedLog;
      timestamps[index] = log.timestamp;
      levels[index] = log.level;
      services[index] = log.service;
      messages[index] = log.message;
      attributes[index] = JSON.stringify(log.attributes);
    }

    await this.sql`
      WITH input AS (
        SELECT *
        FROM unnest(
          ${this.sql.array(timestamps)}::text[],
          ${this.sql.array(levels)}::text[],
          ${this.sql.array(services)}::text[],
          ${this.sql.array(messages)}::text[],
          ${this.sql.array(attributes)}::text[]
        ) AS value(timestamp_text, level_text, service, message, attributes_text)
      ),
      inserted AS (
        INSERT INTO logs (timestamp, level, service, message, attributes)
        SELECT timestamp_text::timestamptz,
               level_text::log_level,
               service,
               message,
               attributes_text::jsonb
        FROM input
        RETURNING timestamp, level, service
      )
      INSERT INTO log_rollups_1m (bucket_start, service, level, count)
      SELECT date_trunc('minute', timestamp), service, level, COUNT(*)::bigint
      FROM inserted
      GROUP BY 1, 2, 3
      ON CONFLICT (bucket_start, service, level)
      DO UPDATE SET count = log_rollups_1m.count + EXCLUDED.count
    `;
  }

  async find(filters: LogQuery): Promise<StoredLog[]> {
    const where = buildWhere(filters);
    where.parameters.push(filters.limit + 1);
    const limitParameter = `$${where.parameters.length}`;
    const rows = await this.sql.unsafe<StoredLogRow[]>(
      `SELECT id::text, timestamp, level, service, message, attributes
       FROM logs l
       WHERE ${where.text}
       ORDER BY timestamp DESC NULLS LAST, id DESC NULLS LAST
       LIMIT ${limitParameter}`,
      where.parameters,
    );

    return rows.map((row) => ({
      ...row,
      timestamp: toIsoTimestamp(row.timestamp),
    }));
  }
}

export { addParameter, buildWhere };
