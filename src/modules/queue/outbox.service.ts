import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";

import type { AcceptedLog, DurableIngestionAcceptor } from "../logs/logs.type.js";
import type { OutboxRepository } from "./outbox.repository.js";
import type { QueuePublisher } from "./queue.publisher.js";

const PUBLISH_BATCH_SIZE = 64;
const FAILURE_RETRY_MS = 1_000;
const AMBIGUOUS_PUBLISH_RETRY_MS = 15_000;
const CONFIRMED_REPLAY_MS = 5 * 60_000;
const IDLE_POLL_MS = 250;
export class OutboxService implements DurableIngestionAcceptor {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private dispatching = false;
  private stopped = true;

  constructor(
    private readonly repository: OutboxRepository,
    private readonly publisher: QueuePublisher,
    private logger?: FastifyBaseLogger,
  ) {}

  setLogger(logger: FastifyBaseLogger): void {
    this.logger = logger;
  }

  async accept(logs: AcceptedLog[]): Promise<void> {
    await this.repository.store(randomUUID(), logs);
    this.wake();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.dispatching) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  wake(): void {
    if (this.stopped || this.running || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.dispatch();
    }, 0);
    this.timer.unref();
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.dispatch();
    }, delayMs);
    this.timer.unref();
  }

  private async dispatch(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    this.dispatching = true;
    let foundWork = false;
    try {
      const batches = await this.repository.claimForPublish(
        PUBLISH_BATCH_SIZE,
        FAILURE_RETRY_MS,
        AMBIGUOUS_PUBLISH_RETRY_MS,
        CONFIRMED_REPLAY_MS,
      );
      foundWork = batches.length > 0;
      if (foundWork) {
        try {
          await this.publisher.publish(batches);
          await this.repository.markPublished(batches.map((batch) => batch.batchId));
        } catch (error) {
          await this.repository.recordPublishFailure(
            batches.map((batch) => batch.batchId),
            error,
          ).catch(() => undefined);
          this.logger?.warn({ err: error }, "Could not publish PostgreSQL outbox batch");
        }
      }
    } catch (error) {
      this.logger?.error({ err: error }, "Could not scan PostgreSQL ingestion outbox");
    } finally {
      this.running = false;
      this.dispatching = false;
      this.schedule(foundWork ? 0 : IDLE_POLL_MS);
    }
  }
}
