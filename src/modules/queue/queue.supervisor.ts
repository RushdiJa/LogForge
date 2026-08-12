import type { FastifyBaseLogger } from "fastify";

import type { OutboxService } from "./outbox.service.js";
import type { QueueRepository } from "./queue.repository.js";
import type { QueueConsumerService } from "./queue.service.js";

const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 5_000;

export class QueueSupervisor {
  private stopping = false;
  private loop: Promise<void> | undefined;
  private signalDisconnect: (() => void) | undefined;

  constructor(
    private readonly url: string,
    private readonly repository: QueueRepository,
    private readonly consumer: QueueConsumerService,
    private readonly outbox: OutboxService,
    private readonly logger: FastifyBaseLogger,
  ) {}

  start(): void {
    if (this.loop !== undefined) return;
    this.stopping = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.signalDisconnect?.();
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    while (!this.stopping) {
      try {
        const disconnected = new Promise<void>((resolve) => {
          this.signalDisconnect = resolve;
        });
        const channels = await this.repository.connect(
          this.url,
          () => this.signalDisconnect?.(),
        );
        channels.connection.on("blocked", (reason) => {
          this.logger.warn({ reason }, "RabbitMQ connection blocked");
        });
        channels.connection.on("unblocked", () => {
          this.logger.info("RabbitMQ connection unblocked");
        });
        await this.consumer.start();
        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
        this.outbox.wake();
        this.logger.info("RabbitMQ ingestion pipeline connected");
        await disconnected;
        if (this.stopping) {
          await this.consumer.stop();
        } else {
          this.consumer.abort();
          this.logger.warn("RabbitMQ connection lost; retrying while PostgreSQL acceptance remains available");
        }
      } catch (error) {
        this.consumer.abort();
        this.logger.warn({ err: error }, "RabbitMQ unavailable; retrying connection");
      } finally {
        this.signalDisconnect = undefined;
        await this.repository.close();
      }

      if (!this.stopping) {
        await new Promise<void>((resolve) => setTimeout(resolve, reconnectDelayMs));
        reconnectDelayMs = Math.min(MAX_RECONNECT_DELAY_MS, reconnectDelayMs * 2);
      }
    }
  }
}
