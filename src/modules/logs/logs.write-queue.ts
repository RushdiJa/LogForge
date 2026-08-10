import type { Log } from "./logs.type.js";

const MAX_QUEUED_LOGS = 30_000;

export type WriteQueueItem = {
  logs: Log[];
  resolve: () => void;
  reject: (error: unknown) => void;
};

const queue: WriteQueueItem[] = [];

let queuedLogsCount = 0;

/**
 * Adds logs to the write queue.
 *
 * The returned promise is resolved only after
 * the worker successfully persists these logs.
 *
 * It is rejected if persistence fails.
 */
export function enqueueLogs(
  logs: Log[],
): Promise<void> {
  if (logs.length === 0) {
    return Promise.resolve();
  }

  if (
    queuedLogsCount + logs.length >
    MAX_QUEUED_LOGS
  ) { 
    return Promise.reject(
      new Error("Log write queue is full"),
    );
  }

  return new Promise<void>(
    (resolve, reject) => {
      queue.push({
        logs,
        resolve,
        reject,
      });

      queuedLogsCount += logs.length;
    },
  );
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
     * If this is not the first item and adding
     * it would exceed maxLogs, stop here.
     */
    if (
      items.length > 0 &&
      logsCount + item.logs.length > maxLogs
    ) {
      break;
    }

    /*
     * Allow a single request larger than maxLogs
     * to pass alone rather than blocking the queue.
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
 * from the front of the queue and resolves
 * their waiting promises.
 */
export function completeQueueItems(
  items: readonly WriteQueueItem[],
): void {
  removeQueueItems(items);

  for (const item of items) {
    item.resolve();
  }
}

/**
 * Removes permanently failed items
 * from the queue and rejects their
 * waiting promises.
 */
export function failQueueItems(
  items: readonly WriteQueueItem[],
  error: unknown,
): void {
  removeQueueItems(items);

  for (const item of items) {
    item.reject(error);
  }
}

export function getQueuedLogsCount(): number {
  return queuedLogsCount;
}

export function getQueueItemsCount(): number {
  return queue.length;
}

function removeQueueItems(
  items: readonly WriteQueueItem[],
): void {
  if (items.length === 0) {
    return;
  }

  /*
   * The worker always works on the front
   * of the queue.
   *
   * Check that the items being removed
   * are actually the same items currently
   * at the front.
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