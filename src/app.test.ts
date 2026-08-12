import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";
import type { Database } from "./db/client.js";
import type { QueuePublisher } from "./modules/logs/logs.type.js";
import { ReadinessState } from "./shared/readiness.js";

const apps: ReturnType<typeof createApp>[] = [];

function testApp() {
  const publisher: QueuePublisher = { publish: vi.fn().mockResolvedValue(undefined) };
  const app = createApp({
    database: {} as Database,
    publisher,
    readiness: new ReadinessState(),
    logLevel: "silent",
  });
  apps.push(app);
  return { app, publisher };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("HTTP contract", () => {
  it("queues valid logs and reports invalid batch indices", async () => {
    const { app, publisher } = testApp();
    const response = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [
          {
            timestamp: "2026-07-20T14:32:01.123Z",
            level: "error",
            service: "checkout",
            message: "payment declined",
            attributes: { user_id: "42" },
          },
          { level: "critical" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: 1, rejected: [{ index: 1 }] });
    expect(publisher.publish).toHaveBeenCalledOnce();
  });

  it("returns the required 400 response for malformed JSON", async () => {
    const { app } = testApp();
    const response = await app.inject({
      method: "POST",
      url: "/logs",
      headers: { "content-type": "application/json" },
      payload: "{",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: "INVALID_JSON", message: "Request body contains malformed JSON" },
    });
  });

  it("returns a consistent 404 response", async () => {
    const { app } = testApp();
    const response = await app.inject({ method: "GET", url: "/unknown" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });
});
