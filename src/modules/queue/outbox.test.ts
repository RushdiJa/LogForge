import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { AcceptedLog } from "../logs/logs.type.js";
import type { OutboxRepository } from "./outbox.repository.js";
import { OutboxService } from "./outbox.service.js";
import type { QueuePublisher } from "./queue.publisher.js";

const logs: AcceptedLog[] = [{
  timestamp: "2026-08-13T00:00:00.000Z",
  level: "info",
  service: "api",
  message: "accepted",
  attributes: {},
}];

describe("PostgreSQL ingestion outbox", () => {
  it("does not resolve acceptance until PostgreSQL stores the complete batch", async () => {
    let finishStore: (() => void) | undefined;
    const store = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => {
        finishStore = resolve;
      }),
    );
    const service = new OutboxService(
      { store } as unknown as OutboxRepository,
      {} as QueuePublisher,
    );

    let accepted = false;
    const accepting = service.accept(logs).then(() => {
      accepted = true;
    });
    await Promise.resolve();

    expect(accepted).toBe(false);
    expect(store).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/), logs);
    finishStore?.();
    await accepting;
    expect(accepted).toBe(true);
  });

  it("retains and records a batch when RabbitMQ publishing fails", async () => {
    const reference = {
      batchId: "00000000-0000-4000-8000-000000000001",
      acceptedCount: 1,
    };
    const claimForPublish = vi
      .fn()
      .mockResolvedValueOnce([reference])
      .mockResolvedValue([]);
    const recordPublishFailure = vi.fn().mockResolvedValue(undefined);
    const publisherError = new Error("RabbitMQ unavailable");
    const publisher = { publish: vi.fn().mockRejectedValue(publisherError) };
    const service = new OutboxService(
      {
        claimForPublish,
        recordPublishFailure,
      } as unknown as OutboxRepository,
      publisher as unknown as QueuePublisher,
      { warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger,
    );

    service.start();
    await vi.waitFor(() => expect(recordPublishFailure).toHaveBeenCalledOnce());
    await service.stop();

    expect(recordPublishFailure).toHaveBeenCalledWith([reference.batchId], publisherError);
  });
});
