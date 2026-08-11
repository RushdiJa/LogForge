import {AggregateFilters, validateLogsFilters, validLogs} from "./logs.validation.js";
import {aggregateLogs, queryLogs} from "./logs.repository.js";
import {LogsError, type ParsedLogsFilters, type ValidateLogsResult} from "./logs.type.js";
import { encodeLogsCursor } from "./logs.utilities.js";
import { enqueueLogs, LogsQueueFullError } from "./logs.write-queue.js";

export async function insertLogs(
  logs: unknown,
): Promise<ValidateLogsResult> {
  const result = validLogs(logs);

  /*
   * Nothing valid can be enqueued.
   * The controller should return HTTP 400.
   */
  if (result.valid.length === 0) {
    return result;
  }

  try {
    /*
     * enqueueLogs is synchronous and returns as soon
     * as the logs enter the in-memory queue.
     */
    enqueueLogs(result.valid);
  } catch (error: unknown) {
    if (error instanceof LogsQueueFullError) {
      throw new LogsError(
        "LOGS_QUEUE_FULL",
        503,
        "Log ingestion queue is full",
      );
    }

    throw error;
  }

  /*
   * The controller can now return HTTP 200 without
   * waiting for PostgreSQL.
   */
  return result;
}

export async function getLogs(filters: unknown){
    const validatedFilters : ParsedLogsFilters = validateLogsFilters(filters);

    const rows = await queryLogs(validatedFilters);

    const hasMore = rows.length > validatedFilters.limit;

    const resultLogs = hasMore
        ? rows.slice(0, validatedFilters.limit)
        : rows;

    const lastLog = resultLogs.at(-1);

    const nextCursor =
        hasMore && lastLog
        ? encodeLogsCursor({
            timestamp: lastLog.timestamp,
            id: lastLog.id,
            })
        : null;

    return {
        logs: resultLogs,
        next_cursor: nextCursor,
    };

}



export async function getLogsAggregate(filters: unknown) {
  const validatedFilters =
    AggregateFilters(filters);

  const resultLogs =
    await aggregateLogs(validatedFilters);

  return {
    buckets: resultLogs.map((bucket) => ({
      ...bucket,
      start: new Date(bucket.start).toISOString(),
    })),
  };
}
