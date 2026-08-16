export type LogLevel =
  | "debug"
  | "info"
  | "warn"
  | "error";


export type Log =  {
  timestamp: Date;
  level: LogLevel;
  service: string;
  message: string;
  attributes: Record<string, string>;
}

export interface RejectedLog {
  index: number;
  reason: string;
}

export interface ValidateLogsResult {
  accepted(accepted: any): unknown;
  valid: Log[];
  rejected: RejectedLog[];
}



export interface FilterResult {
  service?: string;
  level?: LogLevel;
  since?: Date;
  until?: Date;
  attributes?: Record<string, string>;
  q?: string;
  limit: number;
  cursor?: number;
}

export type AggregateBucket = "1m" | "5m" | "1h" | "1d";

export type AggregateGroupBy = "service" | "level";

export interface AggregateFilterResult {
  since: Date;
  until: Date;
  bucket: AggregateBucket;
  groupBy?: AggregateGroupBy;

  service?: string;
  level?: LogLevel;
  attributes?: Record<string, string>;
  q?: string;
}

export interface AggregateResult {
  start: Date;
  group: string | null;
  count: number;
}