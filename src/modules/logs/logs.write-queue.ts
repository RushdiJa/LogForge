import type { Log } from "./logs.type.js";

/*
 * Approximately 10 seconds of logs at 15,000 logs/s.
 *
 * This protects the application from consuming too much
 * memory when PostgreSQL cannot keep up.
 */
const MAX_QUEUED_LOGS = 150_000;

export type WriteQueueItem = {
  logs: Log[];
};

export class LogsQueueFullError extends Error {
  constructor() {
    super("Log write queue is full");
    this.name = "LogsQueueFullError";
  }
}

const queue: WriteQueueItem[] = [];

let queuedLogsCount = 0;

/**
 * Adds logs to the write queue.
 *
 * This function returns immediately after the logs
 * are successfully added to the in-memory queue.
 *
 * It does not wait for PostgreSQL persistence.
 */
export function enqueueLogs(
  logs: Log[],
): void {
  if (logs.length === 0) {
    return;
  }

  if (
    queuedLogsCount + logs.length >
    MAX_QUEUED_LOGS
  ) {
    throw new LogsQueueFullError();
  }

  queue.push({
    logs,
  });

  queuedLogsCount += logs.length;
}

/**
 * Returns items from the front of the queue
 * containing at most maxLogs logs.
 *
 * Nothing is removed from the queue here.
 */
export function peekQueueItems(
  maxLogs: number,
): WriteQueueItem[] {
  if (maxLogs <= 0) {
    return [];
  }

  const items: WriteQueueItem[] = [];

  let logsCount = 0;

  for (const item of queue) {
    /*
     * If this is not the first item and adding it
     * would exceed maxLogs, stop collecting items.
     */
    if (
      items.length > 0 &&
      logsCount + item.logs.length > maxLogs
    ) {
      break;
    }

    /*
     * Allow one request larger than maxLogs to pass
     * alone, preventing it from blocking the queue.
     */
    items.push(item);

    logsCount += item.logs.length;

    if (logsCount >= maxLogs) {
      break;
    }
  }

  return items;
}

/**
 * Removes successfully persisted items
 * from the front of the queue.
 */
export function completeQueueItems(
  items: readonly WriteQueueItem[],
): void {
  removeQueueItems(items);
}

export function getQueuedLogsCount(): number {
  return queuedLogsCount;
}

export function getQueueItemsCount(): number {
  return queue.length;
}

/**
 * Removes items from the front of the queue.
 *
 * This must only be called after PostgreSQL
 * successfully persists the corresponding logs.
 */
function removeQueueItems(
  items: readonly WriteQueueItem[],
): void {
  if (items.length === 0) {
    return;
  }

  /*
   * Verify that the worker is removing the exact
   * items currently located at the queue front.
   */
  for (
    let index = 0;
    index < items.length;
    index++
  ) {
    if (queue[index] !== items[index]) {
      throw new Error(
        "Write queue state is inconsistent",
      );
    }
  }

  let removedLogsCount = 0;

  for (const item of items) {
    removedLogsCount += item.logs.length;
  }

  queue.splice(
    0,
    items.length,
  );

  queuedLogsCount -= removedLogsCount;
}