import { runRetentionCleanup } from "./logs.retention.service.js";

const RETENTION_INTERVAL_MS = 60 * 60 * 1_000;

let retentionTimer: NodeJS.Timeout | undefined;

async function cleanup(): Promise<void> {
  try {
    await runRetentionCleanup();
  } catch (error) {
    console.error("Retention cleanup failed:", error);
  }
}

export function startRetentionJob(): void {
  if (retentionTimer !== undefined) {
    return;
  }

  void cleanup();

  retentionTimer = setInterval(
    () => {
      void cleanup();
    },
    RETENTION_INTERVAL_MS,
  );
}

export function stopRetentionJob(): void {
  if (retentionTimer === undefined) {
    return;
  }

  clearInterval(retentionTimer);
  retentionTimer = undefined;
}
