import { insertLogBatch } from "./repository.js";
import type { Log } from "./type.js";

const FLUSH_DELAY_MS = 50;

let queuedLogs: Log[] = [];
let currentBatch: Promise<void> | undefined;
let lastWrite: Promise<void> = Promise.resolve();

export function enqueueLogs(logs: Log[]): Promise<void> {
  queuedLogs.push(...logs);

  if (currentBatch === undefined) {
    currentBatch = flushBatch();
  }

  return currentBatch;
}

async function flushBatch(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, FLUSH_DELAY_MS);
  });

  const logsToInsert = queuedLogs;

  queuedLogs = [];
  currentBatch = undefined;

  const write = lastWrite.then(() => {
    return insertLogBatch(logsToInsert);
  });

  lastWrite = write.catch(() => {});

  await write;
}