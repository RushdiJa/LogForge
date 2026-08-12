import { InvalidLogsQueryError, InvalidLogsRequestError } from "./logs.error.js";
import {
  LOG_LEVELS,
  type AcceptedLog,
  type CursorValue,
  type LogAttributes,
  type LogLevel,
  type LogQuery,
  type RejectedLog,
} from "./logs.type.js";

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_FUTURE_MS = 5 * 60 * 1_000;
const ALLOWED_QUERY_PARAMETERS = new Set([
  "service",
  "level",
  "since",
  "until",
  "q",
  "limit",
  "cursor",
]);

interface ValidatedBatch {
  valid: AcceptedLog[];
  rejected: RejectedLog[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

function parseTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_8601.test(value)) {
    throw new InvalidLogsQueryError(`${field} must be a valid ISO 8601 timestamp`);
  }

  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs)) {
    throw new InvalidLogsQueryError(`${field} must be a valid ISO 8601 timestamp`);
  }

  return new Date(timestampMs).toISOString();
}

function validateAttributes(value: unknown): { value?: LogAttributes; error?: string } {
  if (value === undefined) {
    return { value: {} };
  }

  if (!isRecord(value)) {
    return { error: "attributes must be a flat object" };
  }

  const attributes: LogAttributes = {};
  for (const [key, attributeValue] of Object.entries(value)) {
    if (key.includes("\0")) {
      return { error: "attribute keys must not contain null bytes" };
    }
    if (
      typeof attributeValue !== "string" &&
      typeof attributeValue !== "number" &&
      typeof attributeValue !== "boolean"
    ) {
      return { error: `attribute '${key}' must be a string, number, or boolean` };
    }

    if (typeof attributeValue === "number" && !Number.isFinite(attributeValue)) {
      return { error: `attribute '${key}' must be a finite number` };
    }
    if (typeof attributeValue === "string" && attributeValue.includes("\0")) {
      return { error: `attribute '${key}' must not contain null bytes` };
    }

    attributes[key] = attributeValue;
  }

  return { value: attributes };
}

function validateLog(value: unknown, nowMs: number): { value?: AcceptedLog; error?: string } {
  if (!isRecord(value)) {
    return { error: "log entry must be an object" };
  }

  const reasons: string[] = [];
  let timestamp: string | undefined;
  if (typeof value.timestamp !== "string" || !ISO_8601.test(value.timestamp)) {
    reasons.push("timestamp must be a valid ISO 8601 timestamp");
  } else {
    const timestampMs = Date.parse(value.timestamp);
    if (!Number.isFinite(timestampMs)) {
      reasons.push("timestamp must be a valid ISO 8601 timestamp");
    } else if (timestampMs > nowMs + MAX_FUTURE_MS) {
      reasons.push("timestamp must not be more than five minutes in the future");
    } else {
      timestamp = new Date(timestampMs).toISOString();
    }
  }

  if (!isLogLevel(value.level)) {
    reasons.push(`invalid level: '${String(value.level)}'`);
  }
  if (typeof value.service !== "string" || value.service.trim().length === 0) {
    reasons.push("service must be a non-empty string");
  } else if (value.service.includes("\0")) {
    reasons.push("service must not contain null bytes");
  }
  if (typeof value.message !== "string" || value.message.trim().length === 0) {
    reasons.push("message must be a non-empty string");
  } else if (value.message.includes("\0")) {
    reasons.push("message must not contain null bytes");
  }

  const attributes = validateAttributes(value.attributes);
  if (attributes.error !== undefined) {
    reasons.push(attributes.error);
  }

  if (reasons.length > 0) {
    return { error: reasons.join(", ") };
  }

  return {
    value: {
      timestamp: timestamp as string,
      level: value.level as LogLevel,
      service: value.service as string,
      message: value.message as string,
      attributes: attributes.value as LogAttributes,
    },
  };
}

export function validateIngestRequest(body: unknown, nowMs = Date.now()): ValidatedBatch {
  if (!isRecord(body) || !Array.isArray(body.logs)) {
    throw new InvalidLogsRequestError("Request body must have the structure { logs: [...] }");
  }

  const valid: AcceptedLog[] = [];
  const rejected: RejectedLog[] = [];

  for (const [index, candidate] of body.logs.entries()) {
    const result = validateLog(candidate, nowMs);
    if (result.value !== undefined) {
      valid.push(result.value);
    } else {
      rejected.push({ index, reason: result.error ?? "invalid log entry" });
    }
  }

  return { valid, rejected };
}

function singleString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new InvalidLogsQueryError(`${name} must be provided once as a string`);
  }
  if (value.includes("\0")) {
    throw new InvalidLogsQueryError(`${name} must not contain null bytes`);
  }
  return value;
}

export function encodeCursor(cursor: CursorValue): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(encoded: string): CursorValue {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!isRecord(decoded) || typeof decoded.timestamp !== "string" || typeof decoded.id !== "string") {
      throw new Error("invalid shape");
    }
    if (!/^\d+$/.test(decoded.id)) {
      throw new Error("invalid id");
    }
    return { timestamp: parseTimestamp(decoded.timestamp, "cursor timestamp"), id: decoded.id };
  } catch (error) {
    if (error instanceof InvalidLogsQueryError) {
      throw error;
    }
    throw new InvalidLogsQueryError("cursor is invalid");
  }
}

export function validateLogQuery(raw: unknown): LogQuery {
  if (!isRecord(raw)) {
    throw new InvalidLogsQueryError("query parameters are invalid");
  }

  const attributes: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(raw)) {
    if (key.startsWith("attr.")) {
      const attributeKey = key.slice(5);
      if (attributeKey.length === 0 || typeof rawValue !== "string") {
        throw new InvalidLogsQueryError(`${key} must contain a key and a single string value`);
      }
      if (attributeKey.includes("\0") || rawValue.includes("\0")) {
        throw new InvalidLogsQueryError(`${key} must not contain null bytes`);
      }
      attributes[attributeKey] = rawValue;
      continue;
    }
    if (!ALLOWED_QUERY_PARAMETERS.has(key)) {
      throw new InvalidLogsQueryError(`unknown query parameter: ${key}`);
    }
  }

  const service = singleString(raw.service, "service");
  const levelValue = singleString(raw.level, "level");
  if (levelValue !== undefined && !isLogLevel(levelValue)) {
    throw new InvalidLogsQueryError("level must be one of: debug, info, warn, error");
  }

  const sinceValue = singleString(raw.since, "since");
  const untilValue = singleString(raw.until, "until");
  const q = singleString(raw.q, "q");
  const cursorValue = singleString(raw.cursor, "cursor");
  const rawLimit = singleString(raw.limit, "limit");
  const limit = rawLimit === undefined ? 100 : Number(rawLimit);

  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000 || !/^\d+$/.test(rawLimit ?? "100")) {
    throw new InvalidLogsQueryError("limit must be an integer between 1 and 1000");
  }

  const since = sinceValue === undefined ? undefined : parseTimestamp(sinceValue, "since");
  const until = untilValue === undefined ? undefined : parseTimestamp(untilValue, "until");
  if (since !== undefined && until !== undefined && Date.parse(since) >= Date.parse(until)) {
    throw new InvalidLogsQueryError("since must be earlier than until");
  }

  return {
    ...(service === undefined ? {} : { service }),
    ...(levelValue === undefined ? {} : { level: levelValue }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    attributes,
    ...(q === undefined ? {} : { q }),
    limit,
    ...(cursorValue === undefined ? {} : { cursor: decodeCursor(cursorValue) }),
  };
}
