import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";
import type { Database } from "./db/client.js";
import type { QueuePublisher } from "./modules/logs/logs.type.js";
import { ReadinessState } from "./shared/readiness.js";

const apps: ReturnType<typeof createApp>[] = [];

function testApp(database = {} as Database) {
  const publisher: QueuePublisher = { publish: vi.fn().mockResolvedValue(undefined) };
  const app = createApp({
    database,
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

  it("traverses equal-timestamp rows deterministically without overlap", async () => {
    const timestamp = "2026-08-12 14:30:00+00";
    const row = (id: string) => ({
      id,
      timestamp,
      level: "error",
      service: "api",
      message: `log-${id}`,
      attributes: {},
    });
    const unsafe = vi
      .fn()
      .mockResolvedValueOnce([row("5"), row("4"), row("3")])
      .mockResolvedValueOnce([row("3"), row("2")]);
    const { app } = testApp({ unsafe } as unknown as Database);

    const firstResponse = await app.inject({
      method: "GET",
      url: "/logs?level=error&limit=2",
    });
    const firstPage = firstResponse.json<{
      logs: Array<{ id: string; timestamp: string }>;
      next_cursor: string | null;
    }>();

    expect(firstResponse.statusCode).toBe(200);
    expect(firstPage.logs.map((log) => log.id)).toEqual(["5", "4"]);
    expect(firstPage.logs.every((log) => log.timestamp === "2026-08-12T14:30:00.000Z"))
      .toBe(true);
    expect(firstPage.next_cursor).toEqual(expect.any(String));

    const secondResponse = await app.inject({
      method: "GET",
      url: `/logs?level=error&limit=2&cursor=${encodeURIComponent(
        firstPage.next_cursor as string,
      )}`,
    });
    const secondPage = secondResponse.json<{
      logs: Array<{ id: string; timestamp: string }>;
      next_cursor: string | null;
    }>();

    expect(secondResponse.statusCode).toBe(200);
    expect(secondPage.logs.map((log) => log.id)).toEqual(["3", "2"]);
    expect(secondPage.logs.map((log) => log.id)).not.toContain("4");
    expect(secondPage.next_cursor).toBeNull();

    const firstSql = String(unsafe.mock.calls[0]?.[0]);
    expect(firstSql).toContain(
      "ORDER BY timestamp DESC NULLS LAST, id DESC NULLS LAST",
    );
    expect(unsafe.mock.calls[1]?.[1]).toEqual([
      "error",
      "2026-08-12T14:30:00.000Z",
      "4",
      3,
    ]);
  });
});
