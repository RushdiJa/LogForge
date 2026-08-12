import type { Database } from "../../db/client.js";
import type { AcceptedLog } from "../logs/logs.type.js";

export interface QueuedBatchReference {
  batchId: string;
  acceptedCount: number;
}

interface ClaimedBatchRow {
  batch_id: string;
  accepted_count: number;
}

export class OutboxRepository {
  constructor(private readonly sql: Database) {}

  async store(batchId: string, logs: AcceptedLog[]): Promise<void> {
    await this.sql`
      INSERT INTO ingestion_batches (batch_id, payload, accepted_count)
      VALUES (${batchId}::uuid, ${JSON.stringify(logs)}::jsonb, ${logs.length})
    `;
  }

  async claimForPublish(
    limit: number,
    failureRetryMs: number,
    ambiguousRetryMs: number,
    confirmedReplayMs: number,
  ): Promise<QueuedBatchReference[]> {
    const rows = await this.sql<ClaimedBatchRow[]>`
      WITH candidates AS (
        SELECT batch_id
        FROM ingestion_batches
        WHERE processed_at IS NULL
          AND (
            last_publish_attempt_at IS NULL
            OR (
              published_at IS NULL
              AND last_publish_error IS NOT NULL
              AND last_publish_attempt_at < NOW() - (${failureRetryMs} * INTERVAL '1 millisecond')
            )
            OR (
              published_at IS NULL
              AND last_publish_error IS NULL
              AND last_publish_attempt_at < NOW() - (${ambiguousRetryMs} * INTERVAL '1 millisecond')
            )
            OR (
              published_at IS NOT NULL
              AND last_publish_attempt_at < NOW() - (${confirmedReplayMs} * INTERVAL '1 millisecond')
            )
          )
        ORDER BY last_publish_attempt_at ASC NULLS FIRST, created_at ASC, batch_id ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ingestion_batches AS batches
      SET last_publish_attempt_at = NOW(),
          publish_attempts = publish_attempts + 1,
          last_publish_error = NULL
      FROM candidates
      WHERE batches.batch_id = candidates.batch_id
      RETURNING batches.batch_id::text, batches.accepted_count
    `;

    return rows.map((row) => ({
      batchId: row.batch_id,
      acceptedCount: row.accepted_count,
    }));
  }

  async markPublished(batchIds: string[]): Promise<void> {
    if (batchIds.length === 0) return;
    await this.sql`
      UPDATE ingestion_batches
      SET published_at = COALESCE(published_at, NOW()),
          last_publish_error = NULL
      WHERE batch_id = ANY(${this.sql.array(batchIds)}::uuid[])
    `;
  }

  async recordPublishFailure(batchIds: string[], error: unknown): Promise<void> {
    if (batchIds.length === 0) return;
    const message = error instanceof Error ? error.message : String(error);
    await this.sql`
      UPDATE ingestion_batches
      SET last_publish_error = ${message.slice(0, 2_000)}
      WHERE batch_id = ANY(${this.sql.array(batchIds)}::uuid[])
        AND processed_at IS NULL
    `;
  }
}
