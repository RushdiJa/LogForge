import { describe, expect, it } from "vitest";

import type { HealthRepository } from "./health.repository.js";
import { HealthService } from "./health.service.js";
import { ReadinessState } from "../../shared/readiness.js";

describe("health readiness", () => {
  it("returns healthy only after startup is complete and the database responds", async () => {
    const readiness = new ReadinessState();
    const repository = { databaseIsReachable: async () => true } as HealthRepository;
    const service = new HealthService(repository, readiness);

    await expect(service.check()).rejects.toMatchObject({ statusCode: 503 });
    readiness.markReady();
    await expect(service.check()).resolves.toEqual({ status: "ok" });
  });
});
