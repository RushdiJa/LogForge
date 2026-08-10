import {AggregateFilters, validateLogsFilters, validLogs} from "./logs.validation.js";
import {aggregateLogs, insertLogsBatch, queryLogs} from "./logs.repository.js";
import {LogsError, type LogsFilters, type ParsedAggregateFilters, type ParsedLogsFilters, type ValidateLogsResult} from "./logs.type.js";
import { encodeLogsCursor } from "./logs.utilities.js";
import { enqueueLogs } from "./logs.write-queue.ts";

export async function insertLogs(logs: unknown) : Promise<ValidateLogsResult> {
    const result : ValidateLogsResult = await validLogs(logs);
    if (result.valid.length > 0) {
      try {
        await enqueueLogs(result.valid);
      } catch {
        throw new LogsError(
          "LOGS_DATABASE_ERROR",
          500,
          "Failed to persist logs",
        );
      }
    }
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