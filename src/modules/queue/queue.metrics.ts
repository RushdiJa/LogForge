import type { FastifyBaseLogger } from "fastify";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

import type { QueueRepository } from "./queue.repository.js";

export class QueueMetrics {
  private publishedLogs = 0;
  private publishedMessages = 0;
  private consumedLogs = 0;
  private consumedMessages = 0;
  private insertedLogs = 0;
  private insertBatches = 0;
  private insertDurationMs = 0;
  private failedInserts = 0;
  private requeuedLogs = 0;
  private invalidMessages = 0;
  private unacknowledgedMessages = 0;
  private latestBatchLogs = 0;
  private latestInsertDurationMs = 0;
  private maximumQueueToDatabaseLagMs = 0;
  private validatedLogs = 0;
  private rejectedLogs = 0;
  private validationDurationMs = 0;
  private publishSerializationDurationMs = 0;
  private publishSerializationBatches = 0;
  private publishConfirmDurationMs = 0;
  private publishConfirmations = 0;
  private failedPublishConfirmations = 0;
  private publisherConfirmationsInFlight = 0;
  private maximumPublisherConfirmationsInFlight = 0;
  private publisherBackpressureEvents = 0;
  private batchPreparationDurationMs = 0;
  private preparedBatches = 0;
  private snapshotAt = Date.now();
  private snapshotPublishedLogs = 0;
  private snapshotConsumedLogs = 0;
  private snapshotInsertedLogs = 0;

  recordPublished(logs: number): void {
    this.publishedLogs += logs;
    this.publishedMessages += 1;
  }

  recordValidation(durationMs: number, acceptedLogs: number, rejectedLogs: number): void {
    this.validatedLogs += acceptedLogs + rejectedLogs;
    this.rejectedLogs += rejectedLogs;
    this.validationDurationMs += durationMs;
  }

  recordPublishSerialization(durationMs: number): void {
    this.publishSerializationDurationMs += durationMs;
    this.publishSerializationBatches += 1;
  }

  recordPublishStarted(): void {
    this.publisherConfirmationsInFlight += 1;
    this.maximumPublisherConfirmationsInFlight = Math.max(
      this.maximumPublisherConfirmationsInFlight,
      this.publisherConfirmationsInFlight,
    );
  }

  recordPublishConfirmation(durationMs: number, succeeded: boolean): void {
    this.publisherConfirmationsInFlight = Math.max(
      0,
      this.publisherConfirmationsInFlight - 1,
    );
    this.publishConfirmations += 1;
    this.publishConfirmDurationMs += durationMs;
    if (!succeeded) {
      this.failedPublishConfirmations += 1;
    }
  }

  recordPublisherBackpressure(): void {
    this.publisherBackpressureEvents += 1;
  }

  recordConsumed(logs: number): void {
    this.consumedLogs += logs;
    this.consumedMessages += 1;
    this.unacknowledgedMessages += 1;
  }

  recordInvalidMessage(): void {
    this.invalidMessages += 1;
  }

  recordInserted(logs: number, durationMs: number, queueToDatabaseLagMs: number): void {
    this.insertedLogs += logs;
    this.insertBatches += 1;
    this.insertDurationMs += durationMs;
    this.latestBatchLogs = logs;
    this.latestInsertDurationMs = durationMs;
    this.maximumQueueToDatabaseLagMs = Math.max(
      this.maximumQueueToDatabaseLagMs,
      queueToDatabaseLagMs,
    );
  }

  recordBatchPreparation(durationMs: number): void {
    this.batchPreparationDurationMs += durationMs;
    this.preparedBatches += 1;
  }

  recordAcknowledged(messages: number): void {
    this.unacknowledgedMessages = Math.max(0, this.unacknowledgedMessages - messages);
  }

  recordInsertFailure(logs: number): void {
    this.failedInserts += 1;
    this.requeuedLogs += logs;
  }

  recordRequeued(messages: number): void {
    this.unacknowledgedMessages = Math.max(0, this.unacknowledgedMessages - messages);
  }

  snapshot(readyMessages: number): Record<string, number> {
    const now = Date.now();
    const elapsedSeconds = Math.max((now - this.snapshotAt) / 1_000, 0.001);
    const publishedLogsPerSecond =
      (this.publishedLogs - this.snapshotPublishedLogs) / elapsedSeconds;
    const consumedLogsPerSecond =
      (this.consumedLogs - this.snapshotConsumedLogs) / elapsedSeconds;
    const insertedLogsPerSecond =
      (this.insertedLogs - this.snapshotInsertedLogs) / elapsedSeconds;

    this.snapshotAt = now;
    this.snapshotPublishedLogs = this.publishedLogs;
    this.snapshotConsumedLogs = this.consumedLogs;
    this.snapshotInsertedLogs = this.insertedLogs;

    return {
      publishedLogs: this.publishedLogs,
      publishedMessages: this.publishedMessages,
      consumedLogs: this.consumedLogs,
      consumedMessages: this.consumedMessages,
      insertedLogs: this.insertedLogs,
      insertBatches: this.insertBatches,
      failedInserts: this.failedInserts,
      requeuedLogs: this.requeuedLogs,
      invalidMessages: this.invalidMessages,
      readyMessages,
      unacknowledgedMessages: this.unacknowledgedMessages,
      latestBatchLogs: this.latestBatchLogs,
      latestInsertDurationMs: Math.round(this.latestInsertDurationMs),
      latestInsertLogsPerSecond:
        this.latestInsertDurationMs === 0
          ? 0
          : Math.round((this.latestBatchLogs * 1_000) / this.latestInsertDurationMs),
      averageInsertDurationMs:
        this.insertBatches === 0 ? 0 : Math.round(this.insertDurationMs / this.insertBatches),
      maximumQueueToDatabaseLagMs: this.maximumQueueToDatabaseLagMs,
      validatedLogs: this.validatedLogs,
      rejectedLogs: this.rejectedLogs,
      averageValidationMicrosecondsPerLog:
        this.validatedLogs === 0
          ? 0
          : Math.round((this.validationDurationMs * 1_000) / this.validatedLogs),
      averagePublishSerializationMs:
        this.publishSerializationBatches === 0
          ? 0
          : Math.round(
              this.publishSerializationDurationMs / this.publishSerializationBatches,
            ),
      averagePublishConfirmMs:
        this.publishConfirmations === 0
          ? 0
          : Math.round(this.publishConfirmDurationMs / this.publishConfirmations),
      failedPublishConfirmations: this.failedPublishConfirmations,
      publisherConfirmationsInFlight: this.publisherConfirmationsInFlight,
      maximumPublisherConfirmationsInFlight: this.maximumPublisherConfirmationsInFlight,
      publisherBackpressureEvents: this.publisherBackpressureEvents,
      averageBatchPreparationMs:
        this.preparedBatches === 0
          ? 0
          : Math.round(this.batchPreparationDurationMs / this.preparedBatches),
      publishedLogsPerSecond: Math.round(publishedLogsPerSecond),
      consumedLogsPerSecond: Math.round(consumedLogsPerSecond),
      insertedLogsPerSecond: Math.round(insertedLogsPerSecond),
    };
  }
}

export class QueueMetricsReporter {
  private timer: NodeJS.Timeout | undefined;
  private reporting = false;
  private eventLoopDelay: IntervalHistogram | undefined;
  private previousCpuUsage = process.cpuUsage();
  private previousReportAt = performance.now();

  constructor(
    private readonly repository: QueueRepository,
    private readonly metrics: QueueMetrics,
    private readonly logger: FastifyBaseLogger,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.intervalMs === 0 || this.timer !== undefined) {
      return;
    }
    this.eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoopDelay.enable();
    this.timer = setInterval(() => void this.report(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.eventLoopDelay?.disable();
    this.eventLoopDelay = undefined;
  }

  private async report(): Promise<void> {
    if (this.reporting) {
      return;
    }
    this.reporting = true;
    try {
      const readyMessages = await this.repository.getReadyMessageCount();
      const now = performance.now();
      const elapsedMicroseconds = Math.max((now - this.previousReportAt) * 1_000, 1);
      const cpuUsage = process.cpuUsage(this.previousCpuUsage);
      const memoryUsage = process.memoryUsage();
      const eventLoopDelay = this.eventLoopDelay;
      const runtimeMetrics = {
        processCpuPercent: Math.round(
          ((cpuUsage.user + cpuUsage.system) / elapsedMicroseconds) * 100,
        ),
        rssBytes: memoryUsage.rss,
        heapUsedBytes: memoryUsage.heapUsed,
        eventLoopDelayP95Ms:
          eventLoopDelay === undefined
            ? 0
            : Math.round(eventLoopDelay.percentile(95) / 1_000_000),
        eventLoopDelayMaxMs:
          eventLoopDelay === undefined
            ? 0
            : Math.round(eventLoopDelay.max / 1_000_000),
      };
      this.previousCpuUsage = process.cpuUsage();
      this.previousReportAt = now;
      eventLoopDelay?.reset();
      this.logger.info(
        { queueMetrics: this.metrics.snapshot(readyMessages), runtimeMetrics },
        "Ingestion pipeline metrics",
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Could not collect queue metrics");
    } finally {
      this.reporting = false;
    }
  }
}
