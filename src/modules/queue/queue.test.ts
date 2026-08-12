import type { Channel, ConsumeMessage } from "amqplib";
import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { LogsRepository } from "../logs/logs.repository.js";
import { QueueMetrics } from "./queue.metrics.js";
import { QueuePublisher } from "./queue.publisher.js";
import type { QueueRepository } from "./queue.repository.js";
import { QueueConsumerService } from "./queue.service.js";
import { parseQueuedBatchReference } from "./queue.validate.js";

function batchId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function processedResult(batchIds: string[], insertedLogs = batchIds.length) {
  return {
    messageCatalogUpsertMs: 0,
    rawInsertMs: 0,
    rollupAggregationMs: 0,
    rollupUpsertMs: 0,
    transactionMs: 1,
    commitAndPoolMs: 1,
    insertedLogs,
    knownBatchIds: new Set(batchIds),
    oldestAcceptedAtMs: Date.now(),
  };
}

function queuedMessage(deliveryTag = 1, logCount = 1): ConsumeMessage {
  return {
    content: Buffer.from(
      JSON.stringify({
        batchId: batchId(deliveryTag),
        acceptedCount: logCount,
      }),
    ),
    fields: {
      consumerTag: "consumer",
      deliveryTag,
      redelivered: false,
      exchange: "",
      routingKey: "logs.ingest",
    },
    properties: {
      contentType: "application/json",
      contentEncoding: undefined,
      headers: {},
      deliveryMode: 2,
      priority: undefined,
      correlationId: undefined,
      replyTo: undefined,
      expiration: undefined,
      messageId: undefined,
      timestamp: Math.floor(Date.now() / 1_000),
      type: undefined,
      userId: undefined,
      appId: undefined,
      clusterId: undefined,
    },
  };
}

function consumerHarness(
  processBatches: ReturnType<typeof vi.fn>,
  options: Partial<{
    flushIntervalMs: number;
    maxBatchLogs: number;
    writeConcurrency: number;
  }> = {},
) {
  let receive: ((message: ConsumeMessage | null) => void) | undefined;
  const channel = {
    prefetch: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockImplementation(
      async (_queue: string, callback: (message: ConsumeMessage | null) => void) => {
        receive = callback;
        return { consumerTag: "consumer" };
      },
    ),
    cancel: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn(),
    nack: vi.fn(),
  } as unknown as Channel;
  const queueRepository = {
    getChannels: () => ({ consumer: channel }),
  } as unknown as QueueRepository;
  const logsRepository = { processBatches } as unknown as LogsRepository;
  const logger = { error: vi.fn() } as unknown as FastifyBaseLogger;
  const service = new QueueConsumerService(
    queueRepository,
    logsRepository,
    logger,
    {
      flushIntervalMs: options.flushIntervalMs ?? 5,
      maxBatchLogs: options.maxBatchLogs ?? 1,
      writeConcurrency: options.writeConcurrency ?? 1,
    },
  );

  return {
    service,
    channel,
    receive: (message: ConsumeMessage) => receive?.(message),
  };
}

describe("internal queue message validation", () => {
  it("reads an internally published batch", () => {
    const content = Buffer.from(JSON.stringify({ batchId: batchId(1), acceptedCount: 500 }));
    expect(parseQueuedBatchReference(content)).toEqual({
      batchId: batchId(1),
      acceptedCount: 500,
    });
  });

  it("rejects malformed internal messages", () => {
    expect(parseQueuedBatchReference(Buffer.from("{"))).toBeNull();
    expect(parseQueuedBatchReference(Buffer.from(JSON.stringify({ value: [] })))).toBeNull();
    expect(
      parseQueuedBatchReference(
        Buffer.from(
          JSON.stringify({
            batchId: "not-a-uuid",
            acceptedCount: 0,
          }),
        ),
      ),
    ).toBeNull();
  });
});

describe("queue metrics", () => {
  it("reports end-to-end counters and local queue state", () => {
    const metrics = new QueueMetrics();
    const request = {};
    metrics.recordHttpRequestStarted(request);
    metrics.recordHttpBodyParsed(request);
    metrics.recordHttpRequestCompleted(request);
    metrics.recordConnectionBlocked();
    metrics.recordConnectionUnblocked();
    metrics.recordValidation(3, 500, 0);
    metrics.recordPublishSerialization(2);
    metrics.recordPublishedPayload(100_000);
    metrics.recordPublishCall(1);
    metrics.recordPublisherBackpressureWait(4);
    metrics.recordPublishStarted();
    metrics.recordPublishConfirmation(5, true);
    metrics.recordPublished(500);
    metrics.recordConsumed(500);
    metrics.recordConsumerParsing(2);
    metrics.recordDeliveredMessageAge(125);
    metrics.recordInserted(500, 25, 750);
    metrics.recordAcknowledged(1);

    expect(metrics.snapshot(3)).toMatchObject({
      publishedLogs: 500,
      consumedLogs: 500,
      insertedLogs: 500,
      insertBatches: 1,
      readyMessages: 3,
      unacknowledgedMessages: 0,
      latestBatchLogs: 500,
      latestInsertDurationMs: 25,
      latestInsertLogsPerSecond: 20_000,
      maximumQueueToDatabaseLagMs: 750,
      averageConsumerParseMs: 2,
      latestDeliveredMessageAgeMs: 125,
      maximumDeliveredMessageAgeMs: 125,
      maximumOutstandingHttpHandlers: 1,
      outstandingHttpHandlers: 0,
      connectionBlockedEvents: 1,
      connectionUnblockedEvents: 1,
      averagePublishedPayloadBytes: 100_000,
      validationCount: 1,
      serializationCount: 1,
      publishCallCount: 1,
      backpressureWaitCount: 1,
      publisherConfirmCount: 1,
      jsonParsingCount: 1,
      totalHttpRequestCount: 1,
    });
  });
});

describe("queue publisher confirmations", () => {
  it("resolves only after RabbitMQ confirms the persistent message", async () => {
    let confirm: ((error: Error | null) => void) | undefined;
    const publish = vi.fn().mockImplementation(
      (
        _exchange: string,
        _routingKey: string,
        _content: Buffer,
        _options: unknown,
        callback: (error: Error | null) => void,
      ) => {
        confirm = callback;
        return true;
      },
    );
    const repository = {
      getChannels: () => ({ publisher: { publish, on: vi.fn(), off: vi.fn() } }),
    } as unknown as QueueRepository;
    const publisher = new QueuePublisher(repository);
    const publishing = publisher.publish([
      { batchId: batchId(1), acceptedCount: 500 },
    ]);
    let settled = false;
    void publishing.finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    confirm?.(null);
    await expect(publishing).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({
        persistent: true,
        mandatory: true,
        messageId: batchId(1),
      }),
      expect.any(Function),
    );
  });

  it("uses one return listener and rejects an unroutable mandatory message", async () => {
    let onReturn: ((message: ConsumeMessage) => void) | undefined;
    let confirm: ((error: Error | null) => void) | undefined;
    const on = vi.fn().mockImplementation(
      (_event: string, listener: (message: ConsumeMessage) => void) => {
        onReturn = listener;
      },
    );
    const off = vi.fn();
    const repository = {
      getChannels: () => ({
        publisher: {
          on,
          off,
          publish: vi.fn().mockImplementation(
            (
              _exchange: string,
              _routingKey: string,
              _content: Buffer,
              _options: unknown,
              callback: (error: Error | null) => void,
            ) => {
              confirm = callback;
              return true;
            },
          ),
        },
      }),
    } as unknown as QueueRepository;
    const publisher = new QueuePublisher(repository);
    const publishing = publisher.publish([{ batchId: batchId(1), acceptedCount: 500 }]);

    await Promise.resolve();
    const returned = queuedMessage(1, 500);
    returned.properties.messageId = batchId(1);
    onReturn?.(returned);
    confirm?.(null);

    await expect(publishing).rejects.toThrow("unroutable batch");
    expect(on).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("rejects when RabbitMQ rejects the publisher confirmation", async () => {
    const confirmationError = new Error("publisher confirm failed");
    const repository = {
      getChannels: () => ({
        publisher: {
          on: vi.fn(),
          off: vi.fn(),
          publish: vi.fn().mockImplementation(
            (
              _exchange: string,
              _routingKey: string,
              _content: Buffer,
              _options: unknown,
              callback: (error: Error | null) => void,
            ) => {
              callback(confirmationError);
              return true;
            },
          ),
        },
      }),
    } as unknown as QueueRepository;
    const publisher = new QueuePublisher(repository);

    await expect(
      publisher.publish([
        { batchId: batchId(1), acceptedCount: 500 },
      ]),
    ).rejects.toBe(confirmationError);
  });
});

describe("queue consumer durability", () => {
  it("combines multiple queue messages into one database transaction", async () => {
    let finishInsert: (() => void) | undefined;
    const processBatches = vi.fn().mockImplementation(
      (ids: string[]) =>
        new Promise((resolve) => {
          finishInsert = () => resolve(processedResult(ids, 2));
        }),
    );
    const harness = consumerHarness(processBatches, {
      flushIntervalMs: 1_000,
      maxBatchLogs: 2,
    });
    await harness.service.start();

    harness.receive(queuedMessage(1));
    harness.receive(queuedMessage(2));

    await vi.waitFor(() => expect(processBatches).toHaveBeenCalledOnce());
    expect(processBatches.mock.calls[0]?.[0]).toHaveLength(2);
    expect(harness.channel.ack).not.toHaveBeenCalled();

    finishInsert?.();
    await vi.waitFor(() => expect(harness.channel.ack).toHaveBeenCalledTimes(2));
    await harness.service.stop();
  });

  it("runs at most the configured number of database writes concurrently", async () => {
    const finishes: Array<() => void> = [];
    const processBatches = vi.fn().mockImplementation(
      (ids: string[]) =>
        new Promise((resolve) => {
          finishes.push(() => resolve(processedResult(ids)));
        }),
    );
    const harness = consumerHarness(processBatches, { writeConcurrency: 2 });
    await harness.service.start();

    harness.receive(queuedMessage(1));
    harness.receive(queuedMessage(2));
    harness.receive(queuedMessage(3));

    await vi.waitFor(() => expect(processBatches).toHaveBeenCalledTimes(2));
    expect(harness.channel.ack).not.toHaveBeenCalled();

    finishes.splice(0).forEach((finish) => finish());
    await vi.waitFor(() => expect(processBatches).toHaveBeenCalledTimes(3));
    finishes.splice(0).forEach((finish) => finish());
    await vi.waitFor(() => expect(harness.channel.ack).toHaveBeenCalledTimes(3));
    await harness.service.stop();
  });

  it("flushes a partial batch when its short wait expires", async () => {
    const processBatches = vi.fn().mockImplementation(
      async (ids: string[]) => processedResult(ids),
    );
    const harness = consumerHarness(processBatches, {
      flushIntervalMs: 5,
      maxBatchLogs: 10,
    });
    await harness.service.start();

    harness.receive(queuedMessage());

    await vi.waitFor(() => expect(processBatches).toHaveBeenCalledOnce());
    expect(processBatches.mock.calls[0]?.[0]).toHaveLength(1);
    await harness.service.stop();
  });

  it("acknowledges a message only after its database insert succeeds", async () => {
    let finishInsert: (() => void) | undefined;
    const processBatches = vi.fn().mockImplementation(
      (ids: string[]) =>
        new Promise((resolve) => {
          finishInsert = () => resolve(processedResult(ids));
        }),
    );
    const harness = consumerHarness(processBatches);
    await harness.service.start();

    harness.receive(queuedMessage());
    await vi.waitFor(() => expect(processBatches).toHaveBeenCalledOnce());
    expect(harness.channel.ack).not.toHaveBeenCalled();

    let stopped = false;
    const stopping = harness.service.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);

    finishInsert?.();
    await vi.waitFor(() => expect(harness.channel.ack).toHaveBeenCalledOnce());
    await stopping;
  });

  it("acknowledges a duplicate delivery without inserting logs twice", async () => {
    const processBatches = vi.fn().mockImplementation(
      async (ids: string[]) => processedResult(ids, 0),
    );
    const harness = consumerHarness(processBatches);
    await harness.service.start();

    harness.receive(queuedMessage());

    await vi.waitFor(() => expect(harness.channel.ack).toHaveBeenCalledOnce());
    expect(processBatches).toHaveBeenCalledOnce();
    await harness.service.stop();
  });

  it("dead-letters a reference that has no PostgreSQL outbox row", async () => {
    const processBatches = vi.fn().mockResolvedValue(processedResult([], 0));
    const harness = consumerHarness(processBatches);
    await harness.service.start();

    harness.receive(queuedMessage());

    await vi.waitFor(() => expect(harness.channel.nack).toHaveBeenCalledOnce());
    expect(harness.channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
    expect(harness.channel.ack).not.toHaveBeenCalled();
    await harness.service.stop();
  });

  it("requeues a failed insert instead of acknowledging it", async () => {
    const processBatches = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const harness = consumerHarness(processBatches);
    await harness.service.start();

    harness.receive(queuedMessage());
    await vi.waitFor(() => expect(harness.channel.nack).toHaveBeenCalledOnce(), {
      timeout: 1_000,
    });
    expect(harness.channel.ack).not.toHaveBeenCalled();
    expect(harness.channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
    await harness.service.stop();
  });
});
