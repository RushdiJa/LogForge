import { pool } from "../db.js";
import type { Log } from "./type.js";

export async function insertLogs(logs: Log[]): Promise<void> {
  const rows: string[] = [];
  const values: unknown[] = [];

  for (let index = 0; index < logs.length; index++) {
    const log = logs[index]!;
    const base = index * 6;

    values.push(
      log.timestamp,
      log.level,
      log.service,
      log.message,
      Object.keys(log.attributes),
      Object.values(log.attributes)
    );

    rows.push(`(
      $${base + 1},
      $${base + 2},
      $${base + 3},
      $${base + 4},
      hstore($${base + 5}::text[], $${base + 6}::text[])
    )`);
}

  await pool.query(
    `
      INSERT INTO logs (
        timestamp,
        level,
        service,
        message,
        attributes
      )
      VALUES ${rows.join(",")}
    `,
    values
  );
}