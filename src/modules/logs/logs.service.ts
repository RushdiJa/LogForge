import {AggregateFilters, validateLogsFilters, validLogs} from "./logs.validation.js";
import {aggregateLogs, insertLog, queryLogs} from "./logs.repository.js";
import {type LogsFilters, type ParsedAggregateFilters, type ParsedLogsFilters, type ValidateLogsResult} from "./logs.type.js";
import { encodeLogsCursor } from "./logs.utilities.js";

export async function insertLogs(logs: unknown) : Promise<ValidateLogsResult> {
    const result : ValidateLogsResult = await validLogs(logs);
    await Promise.all(
        result.valid.map((log) => insertLog(log)),
    );
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