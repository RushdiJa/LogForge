import type { Log, LogLevel, ValidateLogsResult } from "./type.js";

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

  return { valid, rejected };
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