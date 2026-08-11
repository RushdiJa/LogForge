import { insertLogsBatch } from "./logs.repository.js";

import {
  completeQueueItems,
  getQueuedLogsCount,
  peekQueueItems,
  type WriteQueueItem,
} from "./logs.write-queue.js";

import type { Log } from "./logs.type.js";

/*
 * A short batching window amortizes PostgreSQL commit and index
 * maintenance costs. At 15k logs/s this normally produces batches
 * of roughly 3k logs while staying far below the visibility target.
 */
const FLUSH_INTERVAL_MS = 200;

/*
 * Maximum number of logs processed during
 * a single worker cycle.
 */
const MAX_LOGS_PER_CYCLE = 50_000;

/*
 * Maximum number of logs sent to PostgreSQL
 * in one INSERT operation.
 */
const MAX_LOGS_PER_INSERT = 5_000;

const MAX_INSERT_ATTEMPTS = 2;

const RETRY_DELAY_MS = 5;

let workerTimer: NodeJS.Timeout | undefined;

let flushing = false;

/**
 * Starts the background logs write worker.
 */
export function startLogsWriteWorker(): void {
  if (workerTimer !== undefined) {
    return;
  }

  workerTimer = setInterval(() => {
    void flushLogsQueue();
  }, FLUSH_INTERVAL_MS);
}

/**
 * Stops scheduling new worker cycles.
 *
 * If a flush is currently running, this function
 * does not cancel the active database operation.
 */
export function stopLogsWriteWorker(): void {
  if (workerTimer === undefined) {
    return;
  }

  clearInterval(workerTimer);

  workerTimer = undefined;
}

/**
 * Flushes accepted in-memory logs during a graceful shutdown.
 * Returns false when PostgreSQL could not drain the queue before
 * the deadline, allowing the caller to report the data-loss risk.
 */
export async function drainLogsQueue(
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (getQueuedLogsCount() > 0) {
    if (Date.now() >= deadline) {
      return false;
    }

    if (flushing) {
      await delay(10);
      continue;
    }

    await flushLogsQueue();

    if (getQueuedLogsCount() > 0) {
      await delay(25);
    }
  }

  return true;
}

/**
 * Writes queued logs to PostgreSQL.
 *
 * Queue items are removed only after PostgreSQL
 * successfully persists them.
 */
export async function flushLogsQueue(): Promise<void> {
  /*
   * Prevent multiple worker cycles from writing
   * the same queue items concurrently.
   */
  if (flushing) {
    return;
  }

  if (getQueuedLogsCount() === 0) {
    return;
  }

  flushing = true;

  try {
    let processedLogs = 0;

    while (
      processedLogs < MAX_LOGS_PER_CYCLE &&
      getQueuedLogsCount() > 0
    ) {
      const remainingCapacity =
        MAX_LOGS_PER_CYCLE - processedLogs;

      const batchLimit = Math.min(
        MAX_LOGS_PER_INSERT,
        remainingCapacity,
      );

      /*
       * Peek at the queue without removing anything.
       *
       * The items remain in the queue until the
       * database insert succeeds.
       */
      const items = peekQueueItems(batchLimit);

      if (items.length === 0) {
        break;
      }

      const logs = collectLogs(items);

      const result = await insertBatchWithRetry(logs);

      if (!result.success) {
        /*
         * The HTTP request has already received a
         * successful response after enqueueing.
         *
         * Keep these logs at the front of the queue
         * so the next worker cycle retries them.
         */
        console.error(
          `Failed to persist ${logs.length} logs after ${MAX_INSERT_ATTEMPTS} attempts`,
          result.error,
        );

        /*
         * Stop this cycle to avoid immediately retrying
         * the same failed batch in a tight loop.
         */
        break;
      }

      /*
       * PostgreSQL successfully persisted the logs,
       * so they can now be removed from the queue.
       */
      completeQueueItems(items);

      processedLogs += logs.length;
    }
  } finally {
    flushing = false;
  }
}

type InsertResult =
  | {
      success: true;
    }
  | {
      success: false;
      error: unknown;
    };

/**
 * Attempts to persist one batch, retrying temporary
 * database failures a limited number of times.
 */
async function insertBatchWithRetry(
  logs: Log[],
): Promise<InsertResult> {
  let lastError: unknown;

  for (
    let attempt = 1;
    attempt <= MAX_INSERT_ATTEMPTS;
    attempt++
  ) {
    try {
      await insertLogsBatch(logs);

      return {
        success: true,
      };
    } catch (error: unknown) {
      lastError = error;

      if (attempt < MAX_INSERT_ATTEMPTS) {
        await delay(RETRY_DELAY_MS * attempt);
      }
    }
  }

  return {
    success: false,
    error: lastError,
  };
}

/**
 * Combines the logs from multiple queue items
 * into one database insert batch.
 */
function collectLogs(
  items: readonly WriteQueueItem[],
): Log[] {
  const logs: Log[] = [];

  for (const item of items) {
    logs.push(...item.logs);
  }

  return logs;
}

function delay(
  milliseconds: number,
): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
