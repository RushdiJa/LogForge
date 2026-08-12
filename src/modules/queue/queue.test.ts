import type { Channel, ConsumeMessage } from "amqplib";
import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { LogsRepository } from "../logs/logs.repository.js";
import { QueueMetrics } from "./queue.metrics.js";
import { QueuePublisher } from "./queue.publisher.js";
import type { QueueRepository } from "./queue.repository.js";
import { QueueConsumerService } from "./queue.service.js";
import { parseQueuedLogs } from "./queue.validate.js";

function queuedMessage(): ConsumeMessage {
  return {
    content: Buffer.from(
      JSON.stringify({
        logs: [
          {
            timestamp: "2026-07-20T14:00:00.000Z",
            level: "info",
            service: "api",
            message: "ready",
            attributes: {},
          },
        ],
      }),
    ),
    fields: {
      consumerTag: "consumer",
      deliveryTag: 1,
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

function consumerHarness(insertBatch: ReturnType<typeof vi.fn>) {
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
  const logsRepository = { insertBatch } as unknown as LogsRepository;
  const logger = { error: vi.fn() } as unknown as FastifyBaseLogger;
  const service = new QueueConsumerService(
    queueRepository,
    logsRepository,
    logger,
    { flushIntervalMs: 5, maxBatchLogs: 1 },
  );

  return {
    service,
    channel,
    receive: (message: ConsumeMessage) => receive?.(message),
  };
}

describe("internal queue message validation", () => {
  it("reads an internally published batch", () => {
    const content = Buffer.from(
      JSON.stringify({
        logs: [
          {
            timestamp: "2026-07-20T14:00:00.000Z",
            level: "info",
            service: "api",
            message: "ready",
            attributes: {},
          },
        ],
      }),
    );
    expect(parseQueuedLogs(content)).toHaveLength(1);
  });

  it("rejects malformed internal messages", () => {
    expect(parseQueuedLogs(Buffer.from("{"))).toBeNull();
    expect(parseQueuedLogs(Buffer.from(JSON.stringify({ value: [] })))).toBeNull();
    expect(
      parseQueuedLogs(
        Buffer.from(
          JSON.stringify({
            logs: [
              {
                timestamp: "2026-07-20T14:00:00.000Z",
                level: "critical",
                service: "api",
                message: "invalid",
                attributes: {},
              },
            ],
          }),
        ),
      ),
    ).toBeNull();
  });
});

describe("queue metrics", () => {
  it("reports end-to-end counters and local queue state", () => {
    const metrics = new QueueMetrics();
    metrics.recordPublished(500);
    metrics.recordConsumed(500);
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
    });
  });
});

describe("queue publisher confirmations", () => {
  it("resolves only after RabbitMQ confirms the persistent message", async () => {
    let confirm: ((error: Error | null) => void) | undefined;
    const sendToQueue = vi.fn().mockImplementation(
      (
        _queue: string,
        _content: Buffer,
        _options: unknown,
        callback: (error: Error | null) => void,
      ) => {
        confirm = callback;
        return true;
      },
    );
    const repository = {
      getChannels: () => ({ publisher: { sendToQueue } }),
    } as unknown as QueueRepository;
    const publisher = new QueuePublisher(repository);
    const publishing = publisher.publish([
      {
        timestamp: "2026-07-20T14:00:00.000Z",
        level: "info",
        service: "api",
        message: "ready",
        attributes: {},
      },
    ]);
    let settled = false;
    void publishing.finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    confirm?.(null);
    await expect(publishing).resolves.toBeUndefined();
  });

  it("rejects when RabbitMQ rejects the publisher confirmation", async () => {
    const confirmationError = new Error("publisher confirm failed");
    const repository = {
      getChannels: () => ({
        publisher: {
          sendToQueue: vi.fn().mockImplementation(
            (
              _queue: string,
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
        {
          timestamp: "2026-07-20T14:00:00.000Z",
          level: "info",
          service: "api",
          message: "ready",
          attributes: {},
        },
      ]),
    ).rejects.toBe(confirmationError);
  });
});

describe("queue consumer durability", () => {
  it("acknowledges a message only after its database insert succeeds", async () => {
    let finishInsert: (() => void) | undefined;
    const insertBatch = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishInsert = resolve;
        }),
    );
    const harness = consumerHarness(insertBatch);
    await harness.service.start();

    harness.receive(queuedMessage());
    await vi.waitFor(() => expect(insertBatch).toHaveBeenCalledOnce());
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

  it("requeues a failed insert instead of acknowledging it", async () => {
    const insertBatch = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const harness = consumerHarness(insertBatch);
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
