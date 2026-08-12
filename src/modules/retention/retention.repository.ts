import type { Database } from "../../db/client.js";

const DELETE_BATCH_SIZE = 10_000;
const PROCESSED_BATCH_RETENTION_HOURS = 24;

export class RetentionRepository {
  constructor(private readonly sql: Database) {}

  async deleteExpired(retentionDays: number): Promise<number> {
    const result = await this.sql<{ deleted: number }[]>`
      WITH expired AS (
        SELECT id
        FROM logs
        WHERE timestamp < NOW() - (${retentionDays} * INTERVAL '1 day')
        ORDER BY timestamp ASC
        LIMIT ${DELETE_BATCH_SIZE}
      ), deleted AS (
        DELETE FROM logs
        WHERE id IN (SELECT id FROM expired)
        RETURNING 1
      )
      SELECT COUNT(*)::int AS deleted FROM deleted
    `;
    return result[0]?.deleted ?? 0;
  }

  async deleteExpiredRollups(retentionDays: number): Promise<void> {
    await this.sql`
      DELETE FROM log_rollups_1m
      WHERE bucket_start < date_trunc('minute', NOW() - (${retentionDays} * INTERVAL '1 day'))
    `;
  }

  async deleteProcessedIngestionBatches(): Promise<number> {
    const result = await this.sql<{ deleted: number }[]>`
      WITH expired AS (
        SELECT batch_id
        FROM ingestion_batches
        WHERE processed_at < NOW() - (${PROCESSED_BATCH_RETENTION_HOURS} * INTERVAL '1 hour')
        ORDER BY processed_at ASC
        LIMIT ${DELETE_BATCH_SIZE}
      ), deleted AS (
        DELETE FROM ingestion_batches
        WHERE batch_id IN (SELECT batch_id FROM expired)
        RETURNING 1
      )
      SELECT COUNT(*)::int AS deleted FROM deleted
    `;
    return result[0]?.deleted ?? 0;
  }
}
