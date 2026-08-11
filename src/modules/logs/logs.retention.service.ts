import { getRetentionDays } from "../../config/retention.js";
import {
  deleteExpiredLogsBatch,
  pruneExpiredLogRollups,
} from "./logs.retention.repository.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export async function runRetentionCleanup(): Promise<void> {
  const retentionDays = getRetentionDays();

  const cutoff = new Date(
    Date.now() - retentionDays * DAY_MS,
  );

  let deletedCount: number;

  do {
    deletedCount =
      await deleteExpiredLogsBatch(cutoff);
  } while (deletedCount > 0);

  await pruneExpiredLogRollups(cutoff);
}
