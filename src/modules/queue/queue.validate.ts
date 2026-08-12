import { LOG_LEVELS, type AcceptedLog } from "../logs/logs.type.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQueueLog(value: unknown): value is AcceptedLog {
  if (
    !isRecord(value) ||
    typeof value.timestamp !== "string" ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    typeof value.level !== "string" ||
    !(LOG_LEVELS as readonly string[]).includes(value.level) ||
    typeof value.service !== "string" ||
    value.service.length === 0 ||
    value.service.includes("\0") ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    value.message.includes("\0") ||
    !isRecord(value.attributes)
  ) {
    return false;
  }

  for (const [attributeKey, attributeValue] of Object.entries(value.attributes)) {
    if (
      attributeKey.includes("\0") ||
      (typeof attributeValue !== "string" &&
        typeof attributeValue !== "number" &&
        typeof attributeValue !== "boolean") ||
      (typeof attributeValue === "number" && !Number.isFinite(attributeValue)) ||
      (typeof attributeValue === "string" && attributeValue.includes("\0"))
    ) {
      return false;
    }
  }

  return true;
}

export function parseQueuedLogs(content: Buffer): AcceptedLog[] | null {
  try {
    const decoded: unknown = JSON.parse(content.toString("utf8"));
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("logs" in decoded) ||
      !Array.isArray(decoded.logs) ||
      !decoded.logs.every(isQueueLog)
    ) {
      return null;
    }
    return decoded.logs as AcceptedLog[];
  } catch {
    return null;
  }
}
