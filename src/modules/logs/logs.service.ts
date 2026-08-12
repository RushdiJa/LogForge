import { LogsRepository } from "./logs.repository.js";
import type {
  DurableIngestionAcceptor,
  IngestionMetrics,
  IngestResult,
  LogPage,
} from "./logs.type.js";
import { encodeCursor, validateIngestRequest, validateLogQuery } from "./logs.validate.js";

export class LogsService {
  constructor(
    private readonly repository: LogsRepository,
    private readonly ingestion: DurableIngestionAcceptor,
    private readonly metrics?: IngestionMetrics,
  ) {}

  async ingest(body: unknown): Promise<IngestResult> {
    const validationStartedAt = this.metrics === undefined ? 0 : performance.now();
    const { valid, rejected } = validateIngestRequest(body);
    if (this.metrics !== undefined) {
      this.metrics.recordValidation(
        performance.now() - validationStartedAt,
        valid.length,
        rejected.length,
      );
    }

    if (valid.length > 0) {
      await this.ingestion.accept(valid);
    }

    return { accepted: valid.length, rejected };
  }

  async query(rawQuery: unknown): Promise<LogPage> {
    const query = validateLogQuery(rawQuery);
    const rows = await this.repository.find(query);
    const hasMore = rows.length > query.limit;
    const logs = hasMore ? rows.slice(0, query.limit) : rows;
    const last = logs.at(-1);

    return {
      logs,
      next_cursor:
        hasMore && last !== undefined
          ? encodeCursor({ timestamp: last.timestamp, id: last.id })
          : null,
    };
  }
}
