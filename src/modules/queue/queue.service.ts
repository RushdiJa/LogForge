import type { Channel, ConsumeMessage } from "amqplib";
import type { FastifyBaseLogger } from "fastify";

import type { LogsRepository } from "../logs/logs.repository.js";
import type { QueueRepository } from "./queue.repository.js";
import type { QueueMetrics } from "./queue.metrics.js";
import { INGEST_QUEUE, type BufferedMessage } from "./queue.type.js";
import { parseQueuedBatchReference } from "./queue.validate.js";

export interface QueueConsumerOptions {
  flushIntervalMs: number;
  maxBatchLogs: number;
  writeConcurrency: number;
}

export class QueueConsumerService {
  private readonly pending: BufferedMessage[] = [];
  private pendingLogCount = 0;
  private timer: NodeJS.Timeout | undefined;
  private activeFlushes = 0;
  private stopping = false;
  private channel: Channel | undefined;
  private consumerTag: string | undefined;
  private consecutiveInsertFailures = 0;

  constructor(
    private readonly queueRepository: QueueRepository,
    private readonly logsRepository: LogsRepository,
    private readonly logger: FastifyBaseLogger,
    private readonly options: QueueConsumerOptions,
    private readonly metrics?: QueueMetrics,
  ) {}

  async start(): Promise<void> {
    this.stopping = false;
    const channel = this.queueRepository.getChannels().consumer;
    this.channel = channel;
    await channel.prefetch(64);
    const consumer = await channel.consume(INGEST_QUEUE, (message) => this.receive(message), {
      noAck: false,
    });
    this.consumerTag = consumer.consumerTag;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.channel !== undefined && this.consumerTag !== undefined) {
      await this.channel.cancel(this.consumerTag).catch(() => undefined);
      this.consumerTag = undefined;
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.pending.length > 0 || this.activeFlushes > 0) {
      while (
        this.pending.length > 0 &&
        this.activeFlushes < this.options.writeConcurrency
      ) {
        void this.flushOne();
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  abort(): void {
    this.stopping = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.length = 0;
    this.pendingLogCount = 0;
    this.channel = undefined;
    this.consumerTag = undefined;
  }

  private receive(message: ConsumeMessage | null): void {
    if (message === null || this.channel === undefined) {
      return;
    }

    const parsingStartedAt = this.metrics === undefined ? 0 : performance.now();
    const reference = parseQueuedBatchReference(message.content);
    if (this.metrics !== undefined) {
      this.metrics.recordConsumerParsing(performance.now() - parsingStartedAt);
      const publishedAtMs = (message.properties.timestamp ?? 0) * 1_000;
      if (publishedAtMs > 0) {
        this.metrics.recordDeliveredMessageAge(Date.now() - publishedAtMs);
      }
    }
    if (reference === null) {
      this.logger.error("Discarding an invalid internal queue message");
      this.metrics?.recordInvalidMessage();
      this.channel.nack(message, false, false);
      return;
    }

    this.metrics?.recordConsumed(reference.acceptedCount);
    this.pending.push({ message, reference, receivedAt: performance.now() });
    this.pendingLogCount += reference.acceptedCount;

    if (this.pendingLogCount >= this.options.maxBatchLogs) {
      this.dispatchFullBatches();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.dispatchPartialBatch();
      }, this.options.flushIntervalMs);
      this.timer.unref();
    }
  }

  private dispatchFullBatches(): void {
    while (
      this.activeFlushes < this.options.writeConcurrency &&
      this.pending.length > 0 &&
      this.pendingLogCount >= this.options.maxBatchLogs
    ) {
      void this.flushOne();
    }
  }

  private dispatchPartialBatch(): void {
    if (
      this.activeFlushes < this.options.writeConcurrency &&
      this.pending.length > 0
    ) {
      void this.flushOne();
    }
  }

  private async flushOne(): Promise<void> {
    if (
      this.activeFlushes >= this.options.writeConcurrency ||
      this.pending.length === 0 ||
      this.channel === undefined
    ) {
      return;
    }

    this.activeFlushes += 1;
    const messages: BufferedMessage[] = [];
    let logCount = 0;
    let payloadBytes = 0;
    let oldestReceivedAt = performance.now();
    let databaseWriteStartedAt = 0;
    let databaseWriteActive = false;

    while (this.pending.length > 0) {
      const next = this.pending[0];
      if (
        next === undefined ||
        (messages.length > 0 &&
          logCount + next.reference.acceptedCount > this.options.maxBatchLogs)
      ) {
        break;
      }
      messages.push(this.pending.shift() as BufferedMessage);
      logCount += next.reference.acceptedCount;
      payloadBytes += next.message.content.length;
      oldestReceivedAt = Math.min(oldestReceivedAt, next.receivedAt);
      this.pendingLogCount -= next.reference.acceptedCount;
    }

    try {
      this.metrics?.recordBatchAssembly(
        performance.now() - oldestReceivedAt,
        logCount,
        payloadBytes,
      );
      const preparationStartedAt = this.metrics === undefined ? 0 : performance.now();
      const batchIds = messages.map((item) => item.reference.batchId);
      if (this.metrics !== undefined) {
        this.metrics.recordBatchPreparation(performance.now() - preparationStartedAt);
      }

      databaseWriteStartedAt = performance.now();
      databaseWriteActive = true;
      this.metrics?.recordDatabaseWriteStarted();
      const databaseStages = await this.logsRepository.processBatches(batchIds);
      const insertDurationMs = performance.now() - databaseWriteStartedAt;
      this.metrics?.recordDatabaseWriteFinished(insertDurationMs);
      this.metrics?.recordDatabaseStages(databaseStages);
      databaseWriteActive = false;
      this.metrics?.recordInserted(
        databaseStages.insertedLogs,
        insertDurationMs,
        Date.now() - databaseStages.oldestAcceptedAtMs,
      );
      const acknowledgmentStartedAt = performance.now();
      let acknowledged = 0;
      for (const item of messages) {
        if (databaseStages.knownBatchIds.has(item.reference.batchId)) {
          this.channel.ack(item.message);
          acknowledged += 1;
        } else {
          this.channel.nack(item.message, false, false);
        }
      }
      this.metrics?.recordAcknowledged(
        acknowledged,
        performance.now() - acknowledgmentStartedAt,
      );
      this.consecutiveInsertFailures = 0;
    } catch (error) {
      if (databaseWriteActive) {
        this.metrics?.recordDatabaseWriteFinished(
          performance.now() - databaseWriteStartedAt,
        );
      }
      this.consecutiveInsertFailures += 1;
      const retryDelayMs = Math.min(
        5_000,
        100 * 2 ** Math.min(this.consecutiveInsertFailures - 1, 6),
      );
      this.metrics?.recordInsertFailure(logCount);
      this.logger.error(
        { err: error, logCount, retryDelayMs },
        "Database batch insert failed; requeueing logs after backoff",
      );
      if (!this.stopping) {
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
      }
      for (const item of messages) {
        this.channel?.nack(item.message, false, true);
      }
      this.metrics?.recordRequeued(messages.length);
    } finally {
      this.activeFlushes -= 1;
      if (this.pending.length > 0 && !this.stopping) {
        setImmediate(() => {
          this.dispatchFullBatches();
          if (this.timer === undefined && this.pending.length > 0) {
            this.timer = setTimeout(() => {
              this.timer = undefined;
              this.dispatchPartialBatch();
            }, this.options.flushIntervalMs);
            this.timer.unref();
          }
        });
      }
    }
  }
}
