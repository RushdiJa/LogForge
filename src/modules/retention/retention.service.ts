import type { FastifyBaseLogger } from "fastify";

import type { RetentionRepository } from "./retention.repository.js";

const RETENTION_INTERVAL_MS = 60 * 60 * 1_000;
const INITIAL_DELAY_MS = 5 * 60 * 1_000;

export class RetentionService {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repository: RetentionRepository,
    private readonly retentionDays: number,
    private readonly logger: FastifyBaseLogger,
  ) {}

  start(): void {
    this.timer = setTimeout(() => void this.runAndSchedule(), INITIAL_DELAY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async runOnce(): Promise<void> {
    let deleted: number;
    do {
      deleted = await this.repository.deleteExpired(this.retentionDays);
      if (deleted === 10_000) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } while (deleted === 10_000);

    await this.repository.deleteExpiredRollups(this.retentionDays);
  }

  private async runAndSchedule(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error({ err: error }, "Retention cleanup failed");
    } finally {
      this.timer = setTimeout(() => void this.runAndSchedule(), RETENTION_INTERVAL_MS);
      this.timer.unref();
    }
  }
}
