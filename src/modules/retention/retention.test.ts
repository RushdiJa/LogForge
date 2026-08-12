import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { RetentionRepository } from "./retention.repository.js";
import { RetentionService } from "./retention.service.js";

describe("retention cleanup", () => {
  it("deletes expired logs in bounded batches before deleting expired rollups", async () => {
    const deleteExpired = vi
      .fn()
      .mockResolvedValueOnce(10_000)
      .mockResolvedValueOnce(4_000);
    const deleteExpiredRollups = vi.fn().mockResolvedValue(undefined);
    const deleteProcessedIngestionBatches = vi
      .fn()
      .mockResolvedValueOnce(10_000)
      .mockResolvedValueOnce(12);
    const repository = {
      deleteExpired,
      deleteExpiredRollups,
      deleteProcessedIngestionBatches,
    } as unknown as RetentionRepository;
    const service = new RetentionService(
      repository,
      30,
      {} as FastifyBaseLogger,
    );

    await service.runOnce();

    expect(deleteExpired).toHaveBeenCalledTimes(2);
    expect(deleteExpired).toHaveBeenNthCalledWith(1, 30);
    expect(deleteExpired).toHaveBeenNthCalledWith(2, 30);
    expect(deleteExpiredRollups).toHaveBeenCalledOnce();
    expect(deleteExpiredRollups).toHaveBeenCalledWith(30);
    expect(deleteProcessedIngestionBatches).toHaveBeenCalledTimes(2);
  });
});
