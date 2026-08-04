import { except } from "drizzle-orm/gel-core";
import request from "supertest";
import { describe, expect, it } from "vitest";

const BASE_URL = "http://localhost:8080";
type TestLog = {
  timestamp: string;
  level: string;
  service: string;
  message: string;
  attributes?: Record<string, unknown>;
};
type RejectedLog = {
  index: number;
  reason: string;
};

function generateAttributeKey(index: number): string {
  return `field_${index}_${(index * 7919) % 100_000}`;
}
function createValidLog(index: number, baseTime: number): TestLog {
  return {
    timestamp: new Date(baseTime - index * 1_000).toISOString(),
    level: ["debug", "info", "warn", "error"][index % 4]!,
    service: `service-${index}`,
    message: `Generated log message number ${index}`,
    attributes: {
      [generateAttributeKey(index)]: `value-${index}`,
      request_id: `request-${index}`,
      attempt: index % 10,
      successful: index % 2 === 0,
    },
  };
}

describe("POST /logs", () => {
  it("accepts a batch containing one valid log", async () => {
    const response = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send({
        logs: [
          {
            timestamp: new Date().toISOString(),
            level: "error",
            service: "checkout",
            message: "payment declined",
            attributes: {
              user_id: "42",
              region: "eu-west",
              retries: 3,
            },
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      accepted: 1,
      rejected: [],
    });
  });

  it("accepts valid entries and rejects invalid entries in the same batch", async () => {
    const response = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send({
        logs: [
          {
            timestamp: new Date().toISOString(),
            level: "info",
            service: "auth",
            message: "valid log",
          },
          {
            timestamp: new Date().toISOString(),
            level: "critical",
            service: "auth",
            message: "invalid level",
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(1);
    expect(response.body.rejected).toHaveLength(1);
    expect(response.body.rejected[0]).toEqual({
      index: 1,
      reason: expect.any(String),
    });
  });

  it("returns 400 when all entries are rejected", async () => {
    const futureTimestamp = new Date(
      Date.now() + 6 * 60 * 1000,
    ).toISOString();

    const response = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send({
        logs: [
          {
            timestamp: futureTimestamp,
            level: "critical",
            service: "",
            message: "",
            attributes: {
              nested: {
                value: 1,
              },
            },
          },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body.accepted).toBe(0);
    expect(response.body.rejected).toHaveLength(1);
    expect(response.body.rejected[0]).toEqual({
      index: 0,
      reason: expect.any(String),
    });
  });

  it("returns 400 when the top-level structure is invalid", async () => {
    const response = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send({
        logs: "not-an-array",
      });

    expect(response.status).toBe(400);
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send('{"logs": [');

    expect(response.status).toBe(400);
  });

  it("accepts every log in a large batch with arbitrary attribute names", async () => {
    const baseTime = Date.now();
    const logs: TestLog[] = [];

    for (let index = 0; index < 200; index++) {
      logs.push(createValidLog(index, baseTime));
    }

    const response = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send({ logs });

    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(logs.length);
    expect(response.body.rejected).toEqual([]);

    const rejectedIndexes = new Set<number>(
      response.body.rejected.map(
        (rejectedLog: RejectedLog) => rejectedLog.index,
      ),
    );

    for (let index = 0; index < logs.length; index++) {
      const log = logs[index];

      expect(log).toBeDefined();
      expect(rejectedIndexes.has(index)).toBe(false);

      expect(log?.timestamp).toBe(
        new Date(baseTime - index * 1_000).toISOString(),
      );

      expect(log?.service).toBe(`service-${index}`);
      expect(log?.message).toBe(
        `Generated log message number ${index}`,
      );

      expect(log?.attributes).toEqual({
        [generateAttributeKey(index)]: `value-${index}`,
        request_id: `request-${index}`,
        attempt: index % 10,
        successful: index % 2 === 0,
      });
    }
  });
  it("rejects every log whose timestamp is more than five minutes in the future", async () => {
    const baseTime = Date.now();
    const logs: TestLog[] = [];

    for (let index = 0; index < 100; index++) {
      const minutesInFuture = 6 + (index % 20);

      logs.push({
        ...createValidLog(index, baseTime),
        timestamp: new Date(
          baseTime + minutesInFuture * 60 * 1_000,
        ).toISOString(),
        message: `Future log ${index}, ${minutesInFuture} minutes ahead`,
      });
    }

    const response = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send({ logs });

    expect(response.status).toBe(400);
    expect(response.body.accepted).toBe(0);
    expect(response.body.rejected).toHaveLength(logs.length);

    const rejectedByIndex = new Map<number, RejectedLog>(
      response.body.rejected.map(
        (rejectedLog: RejectedLog) => [
          rejectedLog.index,
          rejectedLog,
        ],
      ),
    );

    for (let index = 0; index < logs.length; index++) {
      const originalLog = logs[index];
      const rejectedLog = rejectedByIndex.get(index);

      expect(originalLog).toBeDefined();
      expect(rejectedLog).toBeDefined();
      expect(rejectedLog?.index).toBe(index);
      expect(rejectedLog?.reason).toEqual(expect.any(String));
      expect(rejectedLog?.reason.length).toBeGreaterThan(0);
      expect(rejectedLog?.reason.toLowerCase()).toContain("timestamp");

      const timestampMs = Date.parse(originalLog!.timestamp);

      expect(timestampMs).toBeGreaterThan(
        baseTime + 5 * 60 * 1_000,
      );
    }
  });
  it("checks every log in a large mixed batch with different validation errors", async () => {
    const baseTime = Date.now();
    const logs: TestLog[] = [];
    const expectedValidity: boolean[] = [];
    const expectedReasonFields: string[] = [];

    for (let index = 0; index < 160; index++) {
      const validLog = createValidLog(index, baseTime);
      const errorType = index % 8;

      switch (errorType) {
        case 0:
          logs.push(validLog);
          expectedValidity.push(true);
          expectedReasonFields.push("");
          break;

        case 1:
          logs.push({
            ...validLog,
            service: "",
          });
          expectedValidity.push(false);
          expectedReasonFields.push("service");
          break;

        case 2:
          logs.push({
            ...validLog,
            level: "critical",
          });
          expectedValidity.push(false);
          expectedReasonFields.push("level");
          break;

        case 3:
          logs.push({
            ...validLog,
            message: "",
          });
          expectedValidity.push(false);
          expectedReasonFields.push("message");
          break;

        case 4:
          logs.push({
            ...validLog,
            timestamp: new Date(
              baseTime + 15 * 60 * 1_000,
            ).toISOString(),
          });
          expectedValidity.push(false);
          expectedReasonFields.push("timestamp");
          break;

        case 5:
          logs.push({
            ...validLog,
            attributes: {
              valid: true,
              nested: {
                value: "not allowed",
              },
            },
          });
          expectedValidity.push(false);
          expectedReasonFields.push("attributes");
          break;

        case 6:
          logs.push({
            ...validLog,
            attributes: {
              valid: true,
              invalidArray: [1, 2, 3],
            },
          });
          expectedValidity.push(false);
          expectedReasonFields.push("attributes");
          break;

        case 7:
          logs.push({
            ...validLog,
            timestamp: "not-an-iso-timestamp",
          });
          expectedValidity.push(false);
          expectedReasonFields.push("timestamp");
          break;
      }
    }

    const expectedAccepted = expectedValidity.filter(Boolean).length;
    const expectedRejected = logs.length - expectedAccepted;

    const response = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send({ logs });

    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(expectedAccepted);
    expect(response.body.rejected).toHaveLength(expectedRejected);

    const rejectedByIndex = new Map<number, RejectedLog>(
      response.body.rejected.map(
        (rejectedLog: RejectedLog) => [
          rejectedLog.index,
          rejectedLog,
        ],
      ),
    );

    for (let index = 0; index < logs.length; index++) {
      const shouldBeValid = expectedValidity[index];
      const expectedField = expectedReasonFields[index];
      const rejectedLog = rejectedByIndex.get(index);

      if (shouldBeValid) {
        expect(
          rejectedLog,
          `Log at index ${index} should have been accepted`,
        ).toBeUndefined();

        continue;
      }

      expect(
        rejectedLog,
        `Log at index ${index} should have been rejected`,
      ).toBeDefined();

      expect(rejectedLog?.index).toBe(index);
      expect(rejectedLog?.reason).toEqual(expect.any(String));
      expect(rejectedLog?.reason.length).toBeGreaterThan(0);

      expect(rejectedLog?.reason.toLowerCase()).toContain(
        expectedField,
      );
    }

    for (const rejectedLog of response.body
      .rejected as RejectedLog[]) {
      expect(expectedValidity[rejectedLog.index]).toBe(false);
      expect(rejectedLog.index).toBeGreaterThanOrEqual(0);
      expect(rejectedLog.index).toBeLessThan(logs.length);
    }
  });
  it("returns a clear validation message for every rejected log", async () => {
  const now = Date.now();

  const logs = [
    {
      timestamp: new Date(now).toISOString(),
      level: "info",
      service: "",
      message: "Empty service",
    },
    {
      timestamp: new Date(now).toISOString(),
      level: "critical",
      service: "auth-service",
      message: "Invalid level",
    },
    {
      timestamp: new Date(now).toISOString(),
      level: "warn",
      service: "payment-service",
      message: "",
    },
    {
      timestamp: "not-a-valid-timestamp",
      level: "error",
      service: "api-service",
      message: "Invalid timestamp",
    },
    {
      timestamp: new Date(now + 10 * 60 * 1_000).toISOString(),
      level: "info",
      service: "worker-service",
      message: "Timestamp too far in the future",
    },
    {
      timestamp: new Date(now).toISOString(),
      level: "debug",
      service: "search-service",
      message: "Nested attributes",
      attributes: {
        user: {
          id: 10,
        },
      },
    },
    {
      timestamp: new Date(now).toISOString(),
      level: "info",
      service: "notification-service",
      message: "Array attribute",
      attributes: {
        tags: ["email", "urgent"],
      },
    },
    {
      timestamp: new Date(now).toISOString(),
      level: "warn",
      service: 123,
      message: "Service has the wrong type",
    },
  ];

  const expectedKeywords = [
    "service",
    "level",
    "message",
    "timestamp",
    "timestamp",
    "attributes",
    "attributes",
    "service",
  ];

  const response = await request(BASE_URL)
    .post("/logs")
    .set("Content-Type", "application/json")
    .send({ logs });

  expect(response.status).toBe(400);
  expect(response.body.accepted).toBe(0);
  expect(response.body.rejected).toHaveLength(logs.length);

  for (let index = 0; index < logs.length; index++) {
    const rejectedLog = response.body.rejected.find(
      (item: { index: number }) => item.index === index,
    );

    expect(
      rejectedLog,
      `Missing rejection result for log at index ${index}`,
    ).toBeDefined();

    expect(rejectedLog.reason).toEqual(expect.any(String));

    expect(
      rejectedLog.reason.toLowerCase(),
      `Error message for log at index ${index} should contain "${expectedKeywords[index]}"`,
    ).toContain(expectedKeywords[index]);
  }
});
});