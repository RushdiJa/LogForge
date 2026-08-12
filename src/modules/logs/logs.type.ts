export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogAttributeValue = string | number | boolean;
export type LogAttributes = Record<string, LogAttributeValue>;

export interface AcceptedLog {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  attributes: LogAttributes;
}

export interface RejectedLog {
  index: number;
  reason: string;
}

export interface IngestResult {
  accepted: number;
  rejected: RejectedLog[];
}

export interface StoredLog {
  id: string;
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  attributes: LogAttributes;
}

export interface CursorValue {
  timestamp: string;
  id: string;
}

export interface LogFilters {
  service?: string;
  level?: LogLevel;
  since?: string;
  until?: string;
  attributes: Record<string, string>;
  q?: string;
}

export interface LogQuery extends LogFilters {
  limit: number;
  cursor?: CursorValue;
}

export interface LogPage {
  logs: StoredLog[];
  next_cursor: string | null;
}

export interface QueuePublisher {
  publish(logs: AcceptedLog[]): Promise<void>;
}

export interface IngestionMetrics {
  recordValidation(durationMs: number, acceptedLogs: number, rejectedLogs: number): void;
}
