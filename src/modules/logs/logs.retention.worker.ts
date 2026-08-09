import { runRetentionCleanup } from "./logs.retention.service.js";

const RETENTION_INTERVAL_MS = 60 * 60 * 1_000;

async function cleanup(): Promise<void> {
  try {
    await runRetentionCleanup();
  } catch (error) {
    console.error("Retention cleanup failed:", error);
  }
}

export function startRetentionJob(): void {
  void cleanup();

  setInterval(cleanup, RETENTION_INTERVAL_MS);
}