import { pool } from "./db.js";

const BATCH_SIZE = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export async function retentionWorker(
  repeat = true,
): Promise<void> {
  try {
    const retentionDays = Number(
      process.env.RETENTION_DAYS ?? 30,
    );

    if (
      !Number.isInteger(retentionDays) ||
      retentionDays < 1
    ) {
      throw new Error(
        "RETENTION_DAYS must be a positive integer",
      );
    }

    const cutoff = new Date(
      Date.now() - retentionDays * DAY_MS,
    );

    let deleted: number;

    do {
      const result = await pool.query(
        `
          WITH expired AS (
            SELECT id
            FROM logs
            WHERE timestamp < $1
            ORDER BY timestamp, id
            LIMIT $2
          )
          DELETE FROM logs AS l
          USING expired
          WHERE l.id = expired.id
        `,
        [cutoff, BATCH_SIZE],
      );

      deleted = result.rowCount ?? 0;
    } while (deleted === BATCH_SIZE);
  } catch (error) {
    console.error("Retention cleanup failed", error);
  }

  if (repeat) {
    setTimeout(() => {
      void retentionWorker();
    }, HOUR_MS).unref();
  }
}