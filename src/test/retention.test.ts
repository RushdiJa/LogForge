import {
  afterAll,
  describe,
  expect,
  it,
} from "vitest";

import { pool } from "../db.js";
import { retentionWorker } from "../retention.js";

const URL = "http://localhost:8080/logs";
const service = `retention-test-${Date.now()}`;

describe("log retention", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("deletes expired logs and keeps recent logs", async () => {
    const response = await fetch(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        logs: [
          {
            timestamp: new Date(
              Date.now() - 31 * 24 * 60 * 60 * 1000,
            ).toISOString(),
            level: "info",
            service,
            message: "expired log",
          },
          {
            timestamp: new Date().toISOString(),
            level: "info",
            service,
            message: "recent log",
          },
        ],
      }),
    });

    expect(response.status).toBe(200);

    await retentionWorker(false);

    const logsResponse = await fetch(
      `${URL}?service=${service}`,
    );

    const body = (await logsResponse.json()) as {
      logs: Array<{
        message: string;
      }>;
    };

    expect(logsResponse.status).toBe(200);
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.message).toBe("recent log");
  });
});