export const LOG_LEVELS = [
  "debug",
  "info",
  "warn",
  "error",
] as const;

export type LogLevel =
  (typeof LOG_LEVELS)[number];

export const AGGREGATE_BUCKETS = [
  "1m",
  "5m",
  "1h",
  "1d",
] as const;

export type AggregateBucket =
  (typeof AGGREGATE_BUCKETS)[number];

export const GROUP_BY_VALUES = [
  "service",
  "level",
] as const;

export type AggregateGroupBy =
  (typeof GROUP_BY_VALUES)[number];

export type AttributeValue =
  | string
  | number
  | boolean;

export type Attributes =
  Record<string, AttributeValue>;

/*
 * Shape received from HTTP.
 */
export type LogInput = {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  attributes?: Attributes;
};

/*
 * Internal validated representation.
 *
 * This preserves the old Zod behavior:
 * timestamp string -> Date.
 */
export type Log = {
  timestamp: Date;
  level: LogLevel;
  service: string;
  message: string;
  attributes: Attributes;
};

export type RejectedLog = {
  index: number;
  reason: string;
};

export type ValidateLogsResult = {
  valid: Log[];
  rejected: RejectedLog[];
};

export type LogsErrorCode =
  | "INVALID_REQUEST_BODY"
  | "LOGS_DATABASE_ERROR"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INVALID_QUERY_PARAMETERS";

export class LogsError extends Error {
  public readonly code: LogsErrorCode;
  public readonly statusCode: number;

  constructor(
    code: LogsErrorCode,
    statusCode: number,
    message: string,
  ) {
    super(message);

    this.code = code;
    this.statusCode = statusCode;
    this.name = "LogsError";
  }
}

/*
 * ============================================================
 * GET /logs
 * ============================================================
 */

export type LogsCursor = {
  timestamp: Date;
  id: number;
};

export type LogsFilters = {
  service?: string;
  level?: LogLevel;
  since?: Date;
  until?: Date;
  q?: string;
  limit: number;
  cursor?: LogsCursor;
};

export type AttributeFilters =
  Record<string, string>;

export type ParsedLogsFilters =
  LogsFilters & {
    attributes: AttributeFilters;
  };

/*
 * ============================================================
 * GET /logs/aggregate
 * ============================================================
 */

export type AggregateFilters = {
  service?: string;
  level?: LogLevel;

  since: Date;
  until: Date;

  bucket: AggregateBucket;

  group_by?: AggregateGroupBy;

  q?: string;
};

export type ParsedAggregateFilters =
  AggregateFilters & {
    attributes: AttributeFilters;
  };