import { insertLogsBatch } from "./logs.repository.js";

import {
  completeQueueItems,
  failQueueItems,
  getQueuedLogsCount,
  peekQueueItems,
  type WriteQueueItem,
} from "./logs.write-queue.js";

import type { Log } from "./logs.type.js";

const FLUSH_INTERVAL_MS = 100;

const MAX_LOGS_PER_CYCLE = 12_000;

const MAX_LOGS_PER_INSERT = 3_000;

const MAX_INSERT_ATTEMPTS = 2;

const RETRY_DELAY_MS = 5;

let workerTimer: NodeJS.Timeout | undefined;

let flushing = false;

export function startLogsWriteWorker(): void {
  if (workerTimer !== undefined) {
    return;
  }

  workerTimer = setInterval(() => {
    void flushLogsQueue();
  }, FLUSH_INTERVAL_MS);
}

export function stopLogsWriteWorker(): void {
  if (workerTimer === undefined) {
    return;
  }

  clearInterval(workerTimer);

  workerTimer = undefined;
}

export async function flushLogsQueue(): Promise<void> {
  /*
   * Prevent two worker executions from flushing
   * the queue at the same time.
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
       * Important:
       * peek only.
       *
       * Nothing is removed from the queue
       * before PostgreSQL succeeds.
       */
      const items = peekQueueItems(batchLimit);

      if (items.length === 0) {
        break;
      }

      const logs = collectLogs(items);

      const result =
        await insertBatchWithRetry(logs);

      if (result.success) {
        completeQueueItems(items);
      } else {
        /*
         * Three attempts failed.
         *
         * Remove the items and reject the
         * HTTP requests waiting for them.
         */
        failQueueItems(
          items,
          result.error,
        );

        console.error(
          `Failed to persist ${logs.length} logs after ${MAX_INSERT_ATTEMPTS} attempts`,
          result.error,
        );
      }

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

      if (
        attempt <
        MAX_INSERT_ATTEMPTS
      ) {
        await delay(
          RETRY_DELAY_MS * attempt,
        );
      }
    }
  }

  return {
    success: false,
    error: lastError,
  };
}

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
    setTimeout(
      resolve,
      milliseconds,
    );
  });
}