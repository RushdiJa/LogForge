import { describe, expect, it } from "vitest";
import type { ValidateLogsResult } from "../logs/type.js";

const URL = "http://localhost:8080/logs";

function validLog(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: new Date().toISOString(),
    level: "info",
    service: "checkout",
    message: "payment completed",
    attributes: {
      user_id: "42",
      retries: 3,
      active: true,
    },
    ...overrides,
  };
}

function postLogs(body: unknown) {
  return fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /logs", () => {
  it("accepts a valid log", async () => {
    const response = await postLogs({
      logs: [validLog()],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepted: 1,
      rejected: [],
    });
  });

  it("accepts all supported levels", async () => {
    const levels = ["debug", "info", "warn", "error"];

    const response = await postLogs({
      logs: levels.map((level) => validLog({ level })),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepted: 4,
      rejected: [],
    });
  });

  it("accepts a log without attributes", async () => {
    const response = await postLogs({
      logs: [
        validLog({
          attributes: undefined,
        }),
      ],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepted: 1,
      rejected: [],
    });
  });

  it("accepts valid logs and rejects invalid logs in the same batch", async () => {
    const response = await postLogs({
      logs: [
        validLog(),
        validLog({ level: "critical" }),
        validLog({ service: "" }),
        validLog({ message: "" }),
      ],
    });

    const result = (await response.json()) as ValidateLogsResult;

    expect(response.status).toBe(200);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toHaveLength(3);

    expect(result.rejected.map((item) => item.index)).toEqual([
      1,
      2,
      3,
    ]);
  });

  it("returns 400 when all logs are invalid", async () => {
    const response = await postLogs({
      logs: [
        validLog({ level: "critical" }),
        validLog({ service: "" }),
        validLog({ message: "" }),
      ],
    });

    const result = (await response.json()) as ValidateLogsResult;

    expect(response.status).toBe(400);
    expect(result.accepted).toBe(0);
    expect(result.rejected).toHaveLength(3);
  });

  it("rejects missing required fields", async () => {
    const response = await postLogs({
      logs: [
        {
          level: "error",
          service: "checkout",
          message: "missing timestamp",
        },
        {
          timestamp: new Date().toISOString(),
          service: "checkout",
          message: "missing level",
        },
        {
          timestamp: new Date().toISOString(),
          level: "error",
          message: "missing service",
        },
        {
          timestamp: new Date().toISOString(),
          level: "error",
          service: "checkout",
        },
      ],
    });

    const result = (await response.json()) as ValidateLogsResult;

    expect(response.status).toBe(400);
    expect(result.rejected).toHaveLength(4);
  });

  it("rejects invalid and future timestamps", async () => {
    const futureTimestamp = new Date(
      Date.now() + 6 * 60 * 1000,
    ).toISOString();

    const response = await postLogs({
      logs: [
        validLog({ timestamp: "not-a-timestamp" }),
        validLog({ timestamp: futureTimestamp }),
      ],
    });

    const result = (await response.json()) as ValidateLogsResult;

    expect(response.status).toBe(400);
    expect(result.rejected).toHaveLength(2);
  });

  it("rejects nested objects and arrays in attributes", async () => {
    const response = await postLogs({
      logs: [
        validLog({
          attributes: {
            user: {
              id: "42",
            },
          },
        }),
        validLog({
          attributes: {
            roles: ["admin", "user"],
          },
        }),
      ],
    });

    const result = (await response.json()) as ValidateLogsResult;

    expect(response.status).toBe(400);
    expect(result.rejected).toHaveLength(2);
  });

  it("rejects invalid attribute value types", async () => {
    const response = await postLogs({
      logs: [
        validLog({
          attributes: {
            value: null,
          },
        }),
      ],
    });

    const result = (await response.json()) as ValidateLogsResult;

    expect(response.status).toBe(400);
    expect(result.rejected).toHaveLength(1);
  });

  it.each([
    {},
    { logs: "not-an-array" },
    { logs: [] },
  ])("rejects invalid top-level body: %o", async (body) => {
    const response = await postLogs(body);

    expect(response.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const response = await fetch(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{ invalid json",
    });

    expect(response.status).toBe(400);
  });
});