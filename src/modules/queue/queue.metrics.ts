import type { FastifyBaseLogger } from "fastify";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

import type { QueueRepository } from "./queue.repository.js";

const STAGE_SAMPLE_EVERY = 8;
const MAX_STAGE_SAMPLES = 4_096;

class SampledStage {
  private seen = 0;
  private total = 0;
  private maximum = 0;
  private readonly samples: number[] = [];

  record(value: number): void {
    this.seen += 1;
    this.total += value;
    this.maximum = Math.max(this.maximum, value);
    if (
      (this.seen - 1) % STAGE_SAMPLE_EVERY === 0 &&
      this.samples.length < MAX_STAGE_SAMPLES
    ) {
      this.samples.push(value);
    }
  }

  snapshot(name: string): Record<string, number> {
    if (this.seen === 0) {
      return {
        [`${name}Count`]: 0,
        [`${name}SampleCount`]: 0,
        [`${name}AverageMs`]: 0,
        [`${name}P50Ms`]: 0,
        [`${name}P95Ms`]: 0,
        [`${name}P99Ms`]: 0,
        [`${name}MaxMs`]: 0,
      };
    }

    const sorted = this.samples.toSorted((left, right) => left - right);
    const percentile = (fraction: number): number => {
      const index = Math.min(
        sorted.length - 1,
        Math.ceil(sorted.length * fraction) - 1,
      );
      return sorted[Math.max(0, index)] ?? 0;
    };
    const rounded = (value: number): number => Math.round(value * 100) / 100;

    return {
      [`${name}Count`]: this.seen,
      [`${name}SampleCount`]: sorted.length,
      [`${name}AverageMs`]: rounded(this.total / this.seen),
      [`${name}P50Ms`]: rounded(percentile(0.5)),
      [`${name}P95Ms`]: rounded(percentile(0.95)),
      [`${name}P99Ms`]: rounded(percentile(0.99)),
      [`${name}MaxMs`]: rounded(this.maximum),
    };
  }
}

interface RequestTiming {
  startedAt: number;
}

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
  private consumerParseDurationMs = 0;
  private consumerParsedMessages = 0;
  private latestDeliveredMessageAgeMs = 0;
  private maximumDeliveredMessageAgeMs = 0;
  private readonly requestTimings = new WeakMap<object, RequestTiming>();
  private outstandingHttpHandlers = 0;
  private maximumOutstandingHttpHandlers = 0;
  private connectionBlockedEvents = 0;
  private connectionUnblockedEvents = 0;
  private publishedPayloadBytes = 0;
  private maximumPublishedPayloadBytes = 0;
  private readonly jsonParsing = new SampledStage();
  private readonly validation = new SampledStage();
  private readonly serialization = new SampledStage();
  private readonly publishCall = new SampledStage();
  private readonly backpressureWait = new SampledStage();
  private readonly publisherConfirm = new SampledStage();
  private readonly totalHttpRequest = new SampledStage();
  private snapshotAt = Date.now();
  private snapshotPublishedLogs = 0;
  private snapshotConsumedLogs = 0;
  private snapshotInsertedLogs = 0;

  recordHttpRequestStarted(request: object): void {
    this.requestTimings.set(request, { startedAt: performance.now() });
    this.outstandingHttpHandlers += 1;
    this.maximumOutstandingHttpHandlers = Math.max(
      this.maximumOutstandingHttpHandlers,
      this.outstandingHttpHandlers,
    );
  }

  recordHttpBodyParsed(request: object): void {
    const timing = this.requestTimings.get(request);
    if (timing !== undefined) {
      this.jsonParsing.record(performance.now() - timing.startedAt);
    }
  }

  recordHttpRequestCompleted(request: object): void {
    const timing = this.requestTimings.get(request);
    if (timing !== undefined) {
      this.totalHttpRequest.record(performance.now() - timing.startedAt);
      this.requestTimings.delete(request);
      this.outstandingHttpHandlers = Math.max(0, this.outstandingHttpHandlers - 1);
    }
  }

  recordConnectionBlocked(): void {
    this.connectionBlockedEvents += 1;
  }

  recordConnectionUnblocked(): void {
    this.connectionUnblockedEvents += 1;
  }

  recordPublished(logs: number): void {
    this.publishedLogs += logs;
    this.publishedMessages += 1;
  }

  recordValidation(durationMs: number, acceptedLogs: number, rejectedLogs: number): void {
    this.validatedLogs += acceptedLogs + rejectedLogs;
    this.rejectedLogs += rejectedLogs;
    this.validationDurationMs += durationMs;
    this.validation.record(durationMs);
  }

  recordPublishSerialization(durationMs: number): void {
    this.publishSerializationDurationMs += durationMs;
    this.publishSerializationBatches += 1;
    this.serialization.record(durationMs);
  }

  recordPublishedPayload(bytes: number): void {
    this.publishedPayloadBytes += bytes;
    this.maximumPublishedPayloadBytes = Math.max(this.maximumPublishedPayloadBytes, bytes);
  }

  recordPublishCall(durationMs: number): void {
    this.publishCall.record(durationMs);
  }

  recordPublisherBackpressureWait(durationMs: number): void {
    this.backpressureWait.record(durationMs);
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
    this.publisherConfirm.record(durationMs);
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

  recordConsumerParsing(durationMs: number): void {
    this.consumerParseDurationMs += durationMs;
    this.consumerParsedMessages += 1;
  }

  recordDeliveredMessageAge(ageMs: number): void {
    this.latestDeliveredMessageAgeMs = ageMs;
    this.maximumDeliveredMessageAgeMs = Math.max(
      this.maximumDeliveredMessageAgeMs,
      ageMs,
    );
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
      outstandingHttpHandlers: this.outstandingHttpHandlers,
      maximumOutstandingHttpHandlers: this.maximumOutstandingHttpHandlers,
      connectionBlockedEvents: this.connectionBlockedEvents,
      connectionUnblockedEvents: this.connectionUnblockedEvents,
      publishedPayloadBytes: this.publishedPayloadBytes,
      averagePublishedPayloadBytes:
        this.publishedMessages === 0
          ? 0
          : Math.round(this.publishedPayloadBytes / this.publishedMessages),
      maximumPublishedPayloadBytes: this.maximumPublishedPayloadBytes,
      averageBatchPreparationMs:
        this.preparedBatches === 0
          ? 0
          : Math.round(this.batchPreparationDurationMs / this.preparedBatches),
      averageConsumerParseMs:
        this.consumerParsedMessages === 0
          ? 0
          : Math.round(this.consumerParseDurationMs / this.consumerParsedMessages),
      latestDeliveredMessageAgeMs: this.latestDeliveredMessageAgeMs,
      maximumDeliveredMessageAgeMs: this.maximumDeliveredMessageAgeMs,
      ...this.jsonParsing.snapshot("jsonParsing"),
      ...this.validation.snapshot("validation"),
      ...this.serialization.snapshot("serialization"),
      ...this.publishCall.snapshot("publishCall"),
      ...this.backpressureWait.snapshot("backpressureWait"),
      ...this.publisherConfirm.snapshot("publisherConfirm"),
      ...this.totalHttpRequest.snapshot("totalHttpRequest"),
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
