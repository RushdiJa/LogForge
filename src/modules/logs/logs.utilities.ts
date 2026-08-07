import type { LogsCursor } from "./logs.type.ts";

export function encodeLogsCursor(
  cursor: LogsCursor,
): string {
  const payload = JSON.stringify({
    timestamp: cursor.timestamp.toISOString(),
    id: cursor.id.toString(),
  });

  return Buffer
    .from(payload, "utf8")
    .toString("base64url");
}