import type { QueuedBatchReference } from "./outbox.repository.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseQueuedBatchReference(content: Buffer): QueuedBatchReference | null {
  try {
    const decoded: unknown = JSON.parse(content.toString("utf8"));
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("batchId" in decoded) ||
      typeof decoded.batchId !== "string" ||
      !UUID_PATTERN.test(decoded.batchId) ||
      !("acceptedCount" in decoded) ||
      !Number.isInteger(decoded.acceptedCount) ||
      (decoded.acceptedCount as number) < 1 ||
      (decoded.acceptedCount as number) > 5_000
    ) {
      return null;
    }
    return {
      batchId: decoded.batchId,
      acceptedCount: decoded.acceptedCount as number,
    };
  } catch {
    return null;
  }
}
