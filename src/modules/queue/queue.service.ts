import type { Channel, ConsumeMessage } from "amqplib";
import type { FastifyBaseLogger } from "fastify";

import type { LogsRepository } from "../logs/logs.repository.js";
import type { AcceptedLog } from "../logs/logs.type.js";
import type { QueueRepository } from "./queue.repository.js";
import type { QueueMetrics } from "./queue.metrics.js";
import { INGEST_QUEUE, type BufferedMessage } from "./queue.type.js";
import { parseQueuedLogs } from "./queue.validate.js";

export interface QueueConsumerOptions {
  flushIntervalMs: number;
  maxBatchLogs: number;
}

export class QueueConsumerService {
  private readonly pending: BufferedMessage[] = [];
  private pendingLogCount = 0;
  private timer: NodeJS.Timeout | undefined;
  private flushing = false;
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
    while (this.flushing) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    while (this.pending.length > 0) {
      await this.flush();
    }
  }

  private receive(message: ConsumeMessage | null): void {
    if (message === null || this.channel === undefined) {
      return;
    }

    const logs = parseQueuedLogs(message.content);
    if (logs === null) {
      this.logger.error("Discarding an invalid internal queue message");
      this.metrics?.recordInvalidMessage();
      this.channel.ack(message);
      return;
    }

    this.metrics?.recordConsumed(logs.length);
    this.pending.push({ message, logs });
    this.pendingLogCount += logs.length;

    if (this.pendingLogCount >= this.options.maxBatchLogs) {
      void this.flush();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.options.flushIntervalMs);
      this.timer.unref();
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.pending.length === 0 || this.channel === undefined) {
      return;
    }

    this.flushing = true;
    const messages: BufferedMessage[] = [];
    let logCount = 0;

    while (this.pending.length > 0) {
      const next = this.pending[0];
      if (next === undefined || (messages.length > 0 && logCount + next.logs.length > this.options.maxBatchLogs)) {
        break;
      }
      messages.push(this.pending.shift() as BufferedMessage);
      logCount += next.logs.length;
      this.pendingLogCount -= next.logs.length;
    }

    try {
      const preparationStartedAt = this.metrics === undefined ? 0 : performance.now();
      const logs = new Array<AcceptedLog>(logCount);
      let offset = 0;
      let oldestPublishedAtMs = Date.now();
      for (const item of messages) {
        const publishedAtMs = (item.message.properties.timestamp ?? 0) * 1_000;
        if (publishedAtMs > 0) {
          oldestPublishedAtMs = Math.min(oldestPublishedAtMs, publishedAtMs);
        }
        for (const log of item.logs) {
          logs[offset] = log;
          offset += 1;
        }
      }
      if (this.metrics !== undefined) {
        this.metrics.recordBatchPreparation(performance.now() - preparationStartedAt);
      }

      const insertStartedAt = performance.now();
      await this.logsRepository.insertBatch(logs);
      const insertDurationMs = performance.now() - insertStartedAt;
      this.metrics?.recordInserted(
        logCount,
        insertDurationMs,
        Date.now() - oldestPublishedAtMs,
      );
      for (const item of messages) {
        this.channel.ack(item.message);
      }
      this.metrics?.recordAcknowledged(messages.length);
      this.consecutiveInsertFailures = 0;
    } catch (error) {
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
        this.channel.nack(item.message, false, true);
      }
      this.metrics?.recordRequeued(messages.length);
    } finally {
      this.flushing = false;
      if (this.pending.length > 0 && !this.stopping) {
        setImmediate(() => void this.flush());
      }
    }
  }
}
