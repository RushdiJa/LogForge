import { pg } from "../../db/index.js";

const ROLLUP_INTERVAL_MS = 1000;

let rollupTimer:
  | NodeJS.Timeout
  | undefined;

let processingRollups = false;

export function startLogRollupWorker(): void {
  if (rollupTimer !== undefined) {
    return;
  }

  rollupTimer = setInterval(() => {
    void processRollups();
  }, ROLLUP_INTERVAL_MS);
}

export function stopLogRollupWorker(): void {
  if (rollupTimer === undefined) {
    return;
  }

  clearInterval(rollupTimer);

  rollupTimer = undefined;
}

async function processRollups(): Promise<void> {
  if (processingRollups) {
    return;
  }

  processingRollups = true;

  try {
    await pg`
      SELECT process_log_rollups()
    `;
  } catch (error: unknown) {
    console.error(
      "Failed to process log rollups",
      error,
    );
  } finally {
    processingRollups = false;
  }
}