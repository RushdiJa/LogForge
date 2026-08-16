import type {AggregateBucket, AggregateFilterResult, AggregateGroupBy, FilterResult, Log, LogLevel, ValidateLogsResult } from "./type.js";

const levels = ["debug", "info", "warn", "error"];
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function validateLogs(logs: unknown[]): ValidateLogsResult {
  const valid: Log[] = [];
  const rejected: ValidateLogsResult["rejected"] = [];

  logs.forEach((value, index) => {
    try {
      valid.push(validateLog(value));
    } catch (error) {
      rejected.push({
        index,
        reason: error instanceof Error ? error.message : "Unknown reason",
      });
    }
  });

  return { valid, rejected } as ValidateLogsResult;
}

function validateLog(value: unknown): Log {
  if (typeof value !== "object" || value === null || Array.isArray(value)){
    throw new Error("Invalid log");
  }

  const log = value as Record<string, unknown>;

  if (
    typeof log.timestamp !== "string" ||
    !ISO_8601.test(log.timestamp)
  ) {
    throw new Error("Invalid timestamp");
  }

  const timestamp = new Date(log.timestamp);

  if (Number.isNaN(timestamp.getTime())){
    throw new Error("Invalid timestamp");
  }

  if (timestamp.getTime() > Date.now() + 300_000){
    throw new Error("Timestamp is too far in the future");
  }
  if (typeof log.level !== "string" || !levels.includes(log.level)){
    throw new Error("Invalid level");
  }

  if (typeof log.service !== "string" || !log.service){
    throw new Error("Invalid service");
  }

  if (typeof log.message !== "string" || !log.message){
    throw new Error("Invalid message");
  }

  const attributes: Record<string, string> = {};

  if (log.attributes !== undefined) {
    if (
      typeof log.attributes !== "object" ||
      log.attributes === null ||
      Array.isArray(log.attributes)
    ) {
      throw new Error("Invalid attributes");
    }

    for (const [key, value] of Object.entries(log.attributes)) {
      if (!["string", "number", "boolean"].includes(typeof value))
        throw new Error("Invalid attribute");

      attributes[key] = String(value);
    }
  }

  return {
    timestamp,
    level: log.level as LogLevel,
    service: log.service,
    message: log.message,
    attributes,
  };
}

export function validateFilters(value: unknown): FilterResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid filters");
  }

  const query = value as Record<string, unknown>;
  const result: FilterResult = { limit: 100 };

  if (query.service !== undefined) {
    if (typeof query.service !== "string" || !query.service){
      throw new Error("Invalid service");
    }
    result.service = query.service;
  }

  if (query.level !== undefined) {
    if (
      typeof query.level !== "string" ||
      !levels.includes(query.level)
    ) {
      throw new Error("Invalid level");
    }

    result.level = query.level as LogLevel;
  }

  if (query.since !== undefined) {
    if (typeof query.since !== "string" || !ISO_8601.test(query.since)){
      throw new Error("Invalid since");
    }
    result.since = new Date(query.since);

    if (Number.isNaN(result.since.getTime())){
      throw new Error("Invalid since");
    }
  }

  if (query.until !== undefined) {
    if (typeof query.until !== "string" || !ISO_8601.test(query.until)){
      throw new Error("Invalid until");
    }
    result.until = new Date(query.until);

    if (Number.isNaN(result.until.getTime())){
      throw new Error("Invalid until");
    }
  }

  if (result.since && result.until && result.until < result.since){
    throw new Error("until cannot be earlier than since");
  }
  if (query.q !== undefined) {
    if (typeof query.q !== "string"){
      throw new Error("Invalid q");
    }
    result.q = query.q;
  }

  if (query.limit !== undefined) {
    const limit = Number(query.limit);
    if (
      typeof query.limit !== "string" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000
    ) {
      throw new Error("Invalid limit");
    }

    result.limit = limit;
  }

  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string" || !query.cursor){
      throw new Error("Invalid cursor");
    }

    const decoded = Buffer
      .from(query.cursor, "base64url")
      .toString("utf8");

    const cursor = Number(decoded);

    if (!Number.isSafeInteger(cursor) || cursor < 1) {
      throw new Error("Invalid cursor");
    }

    result.cursor = cursor;
  }

  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith("attr.")) continue;

    const attributeKey = key.slice(5);

    if (!attributeKey){
      throw new Error("Invalid attribute");
    }
    if(typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string"){
      throw new Error("Invalid attribute type");
    }

    result.attributes ??= {};
    result.attributes[attributeKey] = value.toString();
  }

  return result;
}

const buckets = ["1m", "5m", "1h", "1d"];
const groupByValues = ["service", "level"];

export function validateAggregateFilters(
  value: unknown,
): AggregateFilterResult {
  const filters = validateFilters(value);
  const query = value as Record<string, unknown>;

  if (!filters.since) {
    throw new Error("since is required");
  }

  if (!filters.until) {
    throw new Error("until is required");
  }

  if (
    typeof query.bucket !== "string" ||
    !buckets.includes(query.bucket)
  ) {
    throw new Error("Invalid bucket");
  }

  if (
    query.group_by !== undefined &&
    (
      typeof query.group_by !== "string" ||
      !groupByValues.includes(query.group_by)
    )
  ) {
    throw new Error("Invalid group_by");
  }

  if (
    query.limit !== undefined ||
    query.cursor !== undefined
  ) {
    throw new Error(
      "limit and cursor are not supported for aggregation",
    );
  }

  const result: AggregateFilterResult = {
    since: filters.since,
    until: filters.until,
    bucket: query.bucket as AggregateBucket,
  };

  if (filters.service !== undefined) {
    result.service = filters.service;
  }

  if (filters.level !== undefined) {
    result.level = filters.level;
  }

  if (filters.attributes !== undefined) {
    result.attributes = filters.attributes;
  }

  if (filters.q !== undefined) {
    result.q = filters.q;
  }

  if (query.group_by !== undefined) {
    result.groupBy = query.group_by as AggregateGroupBy;
  }

  return result;
}