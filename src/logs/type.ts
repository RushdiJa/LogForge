export type LogLevel =
  | "debug"
  | "info"
  | "warn"
  | "error";


export interface Log {
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
  valid: Log[];
  rejected: RejectedLog[];
}