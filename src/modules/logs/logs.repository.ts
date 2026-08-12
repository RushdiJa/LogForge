import type { Database } from "../../db/client.js";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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

export interface DatabaseBatchTiming {
  messageCatalogUpsertMs: number;
  rawInsertMs: number;
  rollupAggregationMs: number;
  rollupUpsertMs: number;
  transactionMs: number;
  commitAndPoolMs: number;
}

export interface ProcessedBatches extends DatabaseBatchTiming {
  insertedLogs: number;
  knownBatchIds: Set<string>;
  oldestAcceptedAtMs: number;
}

interface IngestionBatchRow {
  batch_id: string;
  payload: AcceptedLog[] | null;
  created_at: Date | string;
}

interface RollupDelta {
  bucketStart: string;
  service: string;
  level: LogLevel;
  count: number;
}

interface ExistsRow {
  exists: boolean;
}

const COPY_CHUNK_BYTES = 256 * 1_024;

export function escapeCopyText(value: string): string {
  return value.replace(/[\\\b\f\n\r\t\v]/g, (character) => {
    switch (character) {
      case "\\":
        return "\\\\";
      case "\b":
        return "\\b";
      case "\f":
        return "\\f";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default:
        return "\\v";
    }
  });
}

function copyChunks(logs: AcceptedLog[]): Iterable<string> {
  return {
    *[Symbol.iterator]() {
      let chunk = "";
      for (const log of logs) {
        const row =
          `${escapeCopyText(log.timestamp)}\t` +
          `${escapeCopyText(log.level)}\t` +
          `${escapeCopyText(log.service)}\t` +
          `${escapeCopyText(log.message)}\t` +
          `${escapeCopyText(JSON.stringify(log.attributes))}\n`;
        if (chunk.length > 0 && chunk.length + row.length > COPY_CHUNK_BYTES) {
          yield chunk;
          chunk = "";
        }
        chunk += row;
      }
      if (chunk.length > 0) {
        yield chunk;
      }
    },
  };
}

function aggregateRollups(logs: AcceptedLog[]): RollupDelta[] {
  const counts = new Map<string, RollupDelta>();
  for (const log of logs) {
    const timestampMs = Date.parse(log.timestamp);
    const bucketStart = new Date(Math.floor(timestampMs / 60_000) * 60_000).toISOString();
    const key = `${bucketStart}\0${log.service}\0${log.level}`;
    const existing = counts.get(key);
    if (existing === undefined) {
      counts.set(key, { bucketStart, service: log.service, level: log.level, count: 1 });
    } else {
      existing.count += 1;
    }
  }
  return [...counts.values()];
}

async function writeLogs(
  transaction: Database,
  logs: AcceptedLog[],
): Promise<Omit<DatabaseBatchTiming, "transactionMs" | "commitAndPoolMs">> {
  const aggregationStartedAt = performance.now();
  const rollups = aggregateRollups(logs);
  const messages = [...new Set(logs.map((log) => log.message))];
  const rollupAggregationMs = performance.now() - aggregationStartedAt;

  const messageCatalogStartedAt = performance.now();
  await transaction`
    INSERT INTO log_message_search (message)
    SELECT DISTINCT message
    FROM unnest(${transaction.array(messages)}::text[]) AS value(message)
    ON CONFLICT (message) DO NOTHING
  `;
  const messageCatalogUpsertMs = performance.now() - messageCatalogStartedAt;

  const rawInsertStartedAt = performance.now();
  const copy = await transaction`
    COPY logs (timestamp, level, service, message, attributes)
    FROM STDIN
  `.writable();
  await pipeline(Readable.from(copyChunks(logs)), copy);
  const rawInsertMs = performance.now() - rawInsertStartedAt;

  const bucketStarts = rollups.map((rollup) => rollup.bucketStart);
  const services = rollups.map((rollup) => rollup.service);
  const levels = rollups.map((rollup) => rollup.level);
  const counts = rollups.map((rollup) => rollup.count);
  const rollupUpsertStartedAt = performance.now();
  await transaction`
    INSERT INTO log_rollups_1m (bucket_start, service, level, count)
    SELECT bucket_start_text::timestamptz,
           service,
           level_text::log_level,
           count::bigint
    FROM unnest(
      ${transaction.array(bucketStarts)}::text[],
      ${transaction.array(services)}::text[],
      ${transaction.array(levels)}::text[],
      ${transaction.array(counts)}::int[]
    ) AS value(bucket_start_text, service, level_text, count)
    ON CONFLICT (bucket_start, service, level)
    DO UPDATE SET count = log_rollups_1m.count + EXCLUDED.count
  `;
  const rollupUpsertMs = performance.now() - rollupUpsertStartedAt;

  return {
    messageCatalogUpsertMs,
    rawInsertMs,
    rollupAggregationMs,
    rollupUpsertMs,
  };
}

function addParameter(query: SqlQuery, value: string | number | boolean | null): string {
  query.parameters.push(value);
  return `$${query.parameters.length}`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function buildWhere(
  filters: LogFilters & { cursor?: LogQuery["cursor"] },
  tableAlias = "l",
  messageSearch: "catalog" | "legacyDirect" | "archiveDirect" = "catalog",
): SqlQuery {
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
    const searchParameter = addParameter(query, `%${escapeLike(filters.q)}%`);
    if (messageSearch !== "catalog") {
      const guardTable = messageSearch === "legacyDirect"
        ? "log_legacy_message_search"
        : "log_hot_archive_message_search";
      conditions.push(
        `EXISTS (
           SELECT 1
           FROM ${guardTable} message_catalog_guard
           WHERE message_catalog_guard.message ILIKE ${searchParameter} ESCAPE '\\'
         )
         AND ${tableAlias}.message ILIKE ${searchParameter} ESCAPE '\\'`,
      );
    } else {
      conditions.push(
        `EXISTS (
           SELECT 1
           FROM log_message_search message_search
           WHERE hashtextextended(message_search.message, 0) =
                 hashtextextended(${tableAlias}.message, 0)
             AND message_search.message = ${tableAlias}.message
             AND message_search.message ILIKE ${searchParameter} ESCAPE '\\'
         )`,
      );
    }
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

  async insertBatch(logs: AcceptedLog[]): Promise<DatabaseBatchTiming | undefined> {
    if (logs.length === 0) {
      return;
    }

    const transactionStartedAt = performance.now();
    let stages: Omit<DatabaseBatchTiming, "transactionMs" | "commitAndPoolMs"> | undefined;

    await this.sql.begin(async (transaction) => {
      stages = await writeLogs(transaction as unknown as Database, logs);
    });

    const transactionMs = performance.now() - transactionStartedAt;
    if (stages === undefined) throw new Error("Database transaction did not execute");
    return {
      ...stages,
      transactionMs,
      commitAndPoolMs: Math.max(
        0,
        transactionMs -
          stages.messageCatalogUpsertMs -
          stages.rawInsertMs -
          stages.rollupUpsertMs,
      ),
    };
  }

  async processBatches(batchIds: string[]): Promise<ProcessedBatches> {
    const uniqueBatchIds = [...new Set(batchIds)];
    const transactionStartedAt = performance.now();
    let insertedLogs = 0;
    let oldestAcceptedAtMs = Date.now();
    let knownBatchIds = new Set<string>();
    let stages = {
      messageCatalogUpsertMs: 0,
      rawInsertMs: 0,
      rollupAggregationMs: 0,
      rollupUpsertMs: 0,
    };

    await this.sql.begin(async (transaction) => {
      const rows = await transaction<IngestionBatchRow[]>`
        SELECT batch_id::text, payload, created_at
        FROM ingestion_batches
        WHERE batch_id = ANY(${transaction.array(uniqueBatchIds)}::uuid[])
        FOR UPDATE
      `;
      knownBatchIds = new Set(rows.map((row) => row.batch_id));
      const pendingRows = rows.filter((row) => row.payload !== null);
      const logs = pendingRows.flatMap((row) => row.payload ?? []);
      insertedLogs = logs.length;
      for (const row of rows) {
        oldestAcceptedAtMs = Math.min(oldestAcceptedAtMs, Date.parse(String(row.created_at)));
      }

      if (logs.length > 0) {
        stages = await writeLogs(transaction as unknown as Database, logs);
        await transaction`
          UPDATE ingestion_batches
          SET processed_at = NOW(),
              published_at = COALESCE(published_at, NOW()),
              payload = NULL,
              last_publish_error = NULL
          WHERE batch_id = ANY(${transaction.array(pendingRows.map((row) => row.batch_id))}::uuid[])
            AND processed_at IS NULL
        `;
      }
    });

    const transactionMs = performance.now() - transactionStartedAt;
    return {
      ...stages,
      transactionMs,
      commitAndPoolMs: Math.max(
        0,
        transactionMs -
          stages.messageCatalogUpsertMs -
          stages.rawInsertMs -
          stages.rollupUpsertMs,
      ),
      insertedLogs,
      knownBatchIds,
      oldestAcceptedAtMs,
    };
  }

  async find(filters: LogQuery): Promise<StoredLog[]> {
    if (filters.q !== undefined) {
      if (!(await this.hasMatchingMessage(filters.q))) return [];
      return this.findByMessage(filters);
    }

    const where = buildWhere(filters);
    where.parameters.push(filters.limit + 1);
    const limitParameter = `$${where.parameters.length}`;
    const rows = await this.sql.unsafe<StoredLogRow[]>(
      `SELECT id::text, timestamp, level, service, message, attributes
       FROM logs l
       WHERE ${where.text}
       ORDER BY l.timestamp DESC NULLS LAST, l.id DESC NULLS LAST
       LIMIT ${limitParameter}`,
      where.parameters,
    );

    return rows.map((row) => ({
      ...row,
      timestamp: toIsoTimestamp(row.timestamp),
    }));
  }

  private async hasMatchingMessage(search: string): Promise<boolean> {
    const rows = await this.sql.unsafe<ExistsRow[]>(
      `SELECT EXISTS (
         SELECT 1
         FROM log_message_search
         WHERE message ILIKE $1 ESCAPE '\\'
       ) AS exists`,
      [`%${escapeLike(search)}%`],
    );
    return rows[0]?.exists === true;
  }

  private async findByMessage(filters: LogQuery): Promise<StoredLog[]> {
    const branchLimit = filters.limit + 1;
    const parameters: SqlQuery["parameters"] = [];
    const branchQueries = [
      { table: "logs_legacy", messageSearch: "legacyDirect" as const },
      { table: "logs_hot_archive", messageSearch: "archiveDirect" as const },
      { table: "logs_hot", messageSearch: "catalog" as const },
    ].map(({ table, messageSearch }) => {
      const where = buildWhere(filters, "l", messageSearch);
      const offset = parameters.length;
      const whereText = where.text.replace(
        /\$(\d+)/g,
        (_placeholder, index: string) => `$${Number(index) + offset}`,
      );
      parameters.push(...where.parameters, branchLimit);
      const limitParameter = `$${parameters.length}`;
      return `(SELECT id, timestamp, level, service, message, attributes
               FROM ${table} l
               WHERE ${whereText}
               ORDER BY timestamp DESC NULLS LAST, id DESC NULLS LAST
               LIMIT ${limitParameter})`;
    });
    parameters.push(branchLimit);
    const finalLimitParameter = `$${parameters.length}`;

    const rows = await this.sql.unsafe<StoredLogRow[]>(
      `WITH candidate_logs AS MATERIALIZED (
         ${branchQueries.join("\n         UNION ALL\n         ")}
       )
       SELECT id::text, timestamp, level, service, message, attributes
       FROM candidate_logs
       ORDER BY timestamp DESC NULLS LAST, id DESC NULLS LAST
       LIMIT ${finalLimitParameter}`,
      parameters,
    );

    return rows.map((row) => ({
      ...row,
      timestamp: toIsoTimestamp(row.timestamp),
    }));
  }
}

export { addParameter, buildWhere };
