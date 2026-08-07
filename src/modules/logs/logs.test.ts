import request from "supertest";
import {
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

const BASE_URL = "http://localhost:8080";

const LEVELS = ["debug", "info", "warn", "error"] as const;

type LogLevel = (typeof LEVELS)[number];

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

type StoredLog = {
  id: string | number;
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  attributes: Record<string, unknown>;
};

type GetLogsResponse = {
  logs: StoredLog[];
  next_cursor: string | null;
};

function generateAttributeKey(index: number): string {
  return `field_${index}_${(index * 7919) % 100_000}`;
}

function createValidLog(index: number, baseTime: number): TestLog {
  return {
    timestamp: new Date(baseTime - index * 1_000).toISOString(),
    level: LEVELS[index % LEVELS.length]!,
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

function expectLogsSortedDescending(logs: StoredLog[]): void {
  for (let index = 1; index < logs.length; index++) {
    const previous = logs[index - 1]!;
    const current = logs[index]!;

    const previousTimestamp = Date.parse(previous.timestamp);
    const currentTimestamp = Date.parse(current.timestamp);

    expect(
      previousTimestamp,
      `log ${index - 1} must not be older than log ${index}`,
    ).toBeGreaterThanOrEqual(currentTimestamp);

    if (previousTimestamp === currentTimestamp) {
      expect(
        Number(previous.id),
        "ids must be descending when timestamps are equal",
      ).toBeGreaterThan(Number(current.id));
    }
  }
}

function expectInvalidGetResponse(response: {
  status: number;
  body: Record<string, unknown>;
}): void {
  expect(response.status).toBe(400);
  expect(response.body).toHaveProperty("error");
  expect(typeof response.body.error).toBe("string");
  expect((response.body.error as string).length).toBeGreaterThan(0);
}

describe("POST /logs", () => {
  // 1
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

  // 2
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
    expect(response.body.rejected[0].reason.toLowerCase()).toContain(
      "level",
    );
  });

  // 3
  it("returns 400 when all entries are rejected", async () => {
    const futureTimestamp = new Date(
      Date.now() + 6 * 60 * 1_000,
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
    expect(response.body.rejected[0].index).toBe(0);
    expect(response.body.rejected[0].reason).toEqual(expect.any(String));
  });

  // 4
  it("rejects invalid request structure, malformed JSON, empty batches, and unsupported media types", async () => {
    const invalidStructure = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send({ logs: "not-an-array" });

    expect(invalidStructure.status).toBe(400);

    const missingLogs = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send({});

    expect(missingLogs.status).toBe(400);

    const emptyBatch = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send({ logs: [] });

    expect(emptyBatch.status).toBe(400);

    const malformedJson = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send('{"logs": [');

    expect(malformedJson.status).toBe(400);

    const unsupportedMediaType = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "text/plain")
      .send("not-json");

    expect(unsupportedMediaType.status).toBe(415);
  });

  // 5
  it("accepts every log in a large batch with arbitrary flat attribute names", async () => {
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
      const log = logs[index]!;

      expect(rejectedIndexes.has(index)).toBe(false);
      expect(log.timestamp).toBe(
        new Date(baseTime - index * 1_000).toISOString(),
      );
      expect(log.service).toBe(`service-${index}`);
      expect(log.message).toBe(
        `Generated log message number ${index}`,
      );
      expect(log.attributes).toEqual({
        [generateAttributeKey(index)]: `value-${index}`,
        request_id: `request-${index}`,
        attempt: index % 10,
        successful: index % 2 === 0,
      });
    }
  });

  // 6
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
        message: `Future log ${index}`,
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
      response.body.rejected.map((rejectedLog: RejectedLog) => [
        rejectedLog.index,
        rejectedLog,
      ]),
    );

    for (let index = 0; index < logs.length; index++) {
      const rejectedLog = rejectedByIndex.get(index);

      expect(rejectedLog).toBeDefined();
      expect(rejectedLog?.index).toBe(index);
      expect(rejectedLog?.reason.toLowerCase()).toContain("timestamp");
    }
  });

  // 7
  it("checks every entry in a large mixed batch with different validation failures", async () => {
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
          logs.push({ ...validLog, service: "" });
          expectedValidity.push(false);
          expectedReasonFields.push("service");
          break;
        case 2:
          logs.push({ ...validLog, level: "critical" });
          expectedValidity.push(false);
          expectedReasonFields.push("level");
          break;
        case 3:
          logs.push({ ...validLog, message: "" });
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
              nested: { value: "not allowed" },
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
      response.body.rejected.map((rejectedLog: RejectedLog) => [
        rejectedLog.index,
        rejectedLog,
      ]),
    );

    for (let index = 0; index < logs.length; index++) {
      const rejectedLog = rejectedByIndex.get(index);

      if (expectedValidity[index]) {
        expect(
          rejectedLog,
          `log ${index} should have been accepted`,
        ).toBeUndefined();
        continue;
      }

      expect(
        rejectedLog,
        `log ${index} should have been rejected`,
      ).toBeDefined();
      expect(rejectedLog?.reason.toLowerCase()).toContain(
        expectedReasonFields[index]!,
      );
    }
  });

  // 8
  it("returns a clear validation reason for every rejected log", async () => {
    const now = Date.now();

    const logs: TestLog[] = [
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
        attributes: { user: { id: 10 } },
      },
      {
        timestamp: new Date(now).toISOString(),
        level: "info",
        service: "notification-service",
        message: "Array attribute",
        attributes: { tags: ["email", "urgent"] },
      },
      {
        timestamp: new Date(now).toISOString(),
        level: "warn",
        service: 123 as unknown as string,
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

      expect(rejectedLog).toBeDefined();
      expect(rejectedLog.reason).toEqual(expect.any(String));
      expect(rejectedLog.reason.toLowerCase()).toContain(
        expectedKeywords[index],
      );
    }
  });
});

describe("GET /logs", () => {
  const runId = `get-logs-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;

  const queryService = `query-service-${runId}`;
  const tieService = `tie-service-${runId}`;
  const baseTime = Date.now() - 60 * 60 * 1_000;

  let seededLogs: TestLog[] = [];
  let tieTimestamp = "";

  beforeAll(async () => {
    seededLogs = Array.from(
      { length: 120 },
      (_, index): TestLog => ({
        timestamp: new Date(
          baseTime - index * 1_000,
        ).toISOString(),
        level: LEVELS[index % LEVELS.length]!,
        service: queryService,
        message: `Query test log ${index} ${runId}`,
        attributes: {
          user_id: `user-${index}`,
          numeric_code: index === 7 ? 42 : 1000 + index,
          boolean_target: index === 9,
          combo: "none",
          attempt: index % 5,
          run_id: runId,
        },
      }),
    );

    seededLogs[10]!.message = `Payment DeCLiNeD ${runId}`;
    seededLogs[11]!.message = `literal 100%_done ${runId}`;
    seededLogs[12]!.attributes = {
      user_id: "multi-user",
      numeric_code: 555,
      boolean_target: false,
      combo: "multi-match",
      attempt: 2,
      run_id: runId,
    };
    seededLogs[13]!.level = "error";
    seededLogs[13]!.message = `Combined Target ${runId}`;
    seededLogs[13]!.attributes = {
      user_id: "combined-user",
      numeric_code: 777,
      boolean_target: true,
      combo: "full-match",
      attempt: 4,
      run_id: runId,
    };
    seededLogs[14]!.message = `literal 100Xdone ${runId}`;

    tieTimestamp = new Date(
      baseTime - 10 * 60 * 1_000,
    ).toISOString();

    const tieLogs: TestLog[] = Array.from(
      { length: 5 },
      (_, index) => ({
        timestamp: tieTimestamp,
        level: "info",
        service: tieService,
        message: `Tie log ${index} ${runId}`,
        attributes: {
          run_id: runId,
          tie_index: index,
        },
      }),
    );

    const response = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send({ logs: [...seededLogs, ...tieLogs] });

    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(125);
    expect(response.body.rejected).toEqual([]);
  });

  // 9
  it("supports no query parameters and uses the default limit of 100", async () => {
    const unfilteredResponse = await request(BASE_URL).get("/logs");

    expect(unfilteredResponse.status).toBe(200);

    const unfilteredBody = unfilteredResponse.body as GetLogsResponse;

    expect(unfilteredBody.logs.length).toBeLessThanOrEqual(100);
    expectLogsSortedDescending(unfilteredBody.logs);

    const scopedResponse = await request(BASE_URL)
      .get("/logs")
      .query({ service: queryService });

    expect(scopedResponse.status).toBe(200);

    const scopedBody = scopedResponse.body as GetLogsResponse;

    expect(scopedBody.logs).toHaveLength(100);
    expect(scopedBody.next_cursor).toEqual(expect.any(String));

    for (const log of scopedBody.logs) {
      expect(log.service).toBe(queryService);
    }

    expectLogsSortedDescending(scopedBody.logs);
  });

  // 10
  it("filters by exact service name", async () => {
    const response = await request(BASE_URL)
      .get("/logs")
      .query({
        service: queryService,
        limit: 1000,
      });

    expect(response.status).toBe(200);

    const body = response.body as GetLogsResponse;

    expect(body.logs).toHaveLength(seededLogs.length);
    expect(body.next_cursor).toBeNull();

    for (const log of body.logs) {
      expect(log.service).toBe(queryService);
    }
  });

  // 11
  it("filters by exact log level", async () => {
    const response = await request(BASE_URL)
      .get("/logs")
      .query({
        service: queryService,
        level: "error",
        limit: 1000,
      });

    expect(response.status).toBe(200);

    const body = response.body as GetLogsResponse;
    const expectedCount = seededLogs.filter(
      (log) => log.level === "error",
    ).length;

    expect(body.logs).toHaveLength(expectedCount);

    for (const log of body.logs) {
      expect(log.service).toBe(queryService);
      expect(log.level).toBe("error");
    }
  });

  // 12
  it("treats since as inclusive and until as exclusive", async () => {
    const sinceBoundary = seededLogs[30]!.timestamp;
    const untilBoundary = seededLogs[10]!.timestamp;

    const sinceResponse = await request(BASE_URL)
      .get("/logs")
      .query({
        service: queryService,
        since: sinceBoundary,
        limit: 1000,
      });

    expect(sinceResponse.status).toBe(200);

    const sinceBody = sinceResponse.body as GetLogsResponse;

    expect(
      sinceBody.logs.some(
        (log) => log.timestamp === sinceBoundary,
      ),
    ).toBe(true);

    for (const log of sinceBody.logs) {
      expect(Date.parse(log.timestamp)).toBeGreaterThanOrEqual(
        Date.parse(sinceBoundary),
      );
    }

    const untilResponse = await request(BASE_URL)
      .get("/logs")
      .query({
        service: queryService,
        until: untilBoundary,
        limit: 1000,
      });

    expect(untilResponse.status).toBe(200);

    const untilBody = untilResponse.body as GetLogsResponse;

    expect(
      untilBody.logs.some(
        (log) => log.timestamp === untilBoundary,
      ),
    ).toBe(false);

    for (const log of untilBody.logs) {
      expect(Date.parse(log.timestamp)).toBeLessThan(
        Date.parse(untilBoundary),
      );
    }
  });

  // 13
  it("matches q as a case-insensitive literal substring", async () => {
    const declinedResponse = await request(BASE_URL)
      .get("/logs")
      .query({
        service: queryService,
        q: "PAYMENT declined",
        limit: 1000,
      });

    expect(declinedResponse.status).toBe(200);
    expect(declinedResponse.body.logs).toHaveLength(1);
    expect(declinedResponse.body.logs[0].message).toContain(
      "Payment DeCLiNeD",
    );

    const wildcardResponse = await request(BASE_URL)
      .get("/logs")
      .query({
        service: queryService,
        q: "%_done",
        limit: 1000,
      });

    expect(wildcardResponse.status).toBe(200);
    expect(wildcardResponse.body.logs).toHaveLength(1);
    expect(wildcardResponse.body.logs[0].message).toContain(
      "100%_done",
    );
    expect(wildcardResponse.body.logs[0].message).not.toContain(
      "100Xdone",
    );
  });

  // 14
  it("filters attributes by string equality for string, number, and boolean values", async () => {
    const stringResponse = await request(BASE_URL)
      .get("/logs")
      .query({
        service: queryService,
        "attr.user_id": "user-8",
        limit: 1000,
      });

    expect(stringResponse.status).toBe(200);
    expect(stringResponse.body.logs).toHaveLength(1);
    expect(stringResponse.body.logs[0].attributes.user_id).toBe(
      "user-8",
    );

    const numberResponse = await request(BASE_URL)
      .get("/logs")
      .query({
        service: queryService,
        "attr.numeric_code": "42",
        limit: 1000,
      });

    expect(numberResponse.status).toBe(200);
    expect(numberResponse.body.logs).toHaveLength(1);
    expect(numberResponse.body.logs[0].attributes.numeric_code).toBe(
      42,
    );

    const booleanResponse = await request(BASE_URL)
      .get("/logs")
      .query({
        service: queryService,
        "attr.boolean_target": "true",
        "attr.user_id": "user-9",
        limit: 1000,
      });

    expect(booleanResponse.status).toBe(200);
    expect(booleanResponse.body.logs).toHaveLength(1);
    expect(
      booleanResponse.body.logs[0].attributes.boolean_target,
    ).toBe(true);
  });

  // 15
  it("freely combines service, level, time, q, and multiple attribute filters", async () => {
    const target = seededLogs[13]!;
    const targetTimestamp = Date.parse(target.timestamp);

    const response = await request(BASE_URL)
      .get("/logs")
      .query({
        service: queryService,
        level: "error",
        since: target.timestamp,
        until: new Date(targetTimestamp + 1).toISOString(),
        q: "combined target",
        "attr.combo": "full-match",
        "attr.numeric_code": "777",
        "attr.boolean_target": "true",
        limit: 1000,
      });

    expect(response.status).toBe(200);

    const body = response.body as GetLogsResponse;

    expect(body.logs).toHaveLength(1);

    const log = body.logs[0]!;

    expect(log.timestamp).toBe(target.timestamp);
    expect(log.level).toBe("error");
    expect(log.service).toBe(queryService);
    expect(log.message.toLowerCase()).toContain("combined target");
    expect(log.attributes.combo).toBe("full-match");
    expect(log.attributes.numeric_code).toBe(777);
    expect(log.attributes.boolean_target).toBe(true);
  });

  // 16
  it("keeps ordering and cursor traversal deterministic when timestamps are equal", async () => {
    const fullResponse = await request(BASE_URL)
      .get("/logs")
      .query({
        service: tieService,
        limit: 1000,
      });

    expect(fullResponse.status).toBe(200);

    const fullBody = fullResponse.body as GetLogsResponse;

    expect(fullBody.logs).toHaveLength(5);

    for (const log of fullBody.logs) {
      expect(log.timestamp).toBe(tieTimestamp);
    }

    expectLogsSortedDescending(fullBody.logs);

    const expectedIds = fullBody.logs.map((log) => String(log.id));
    const pagedIds: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 3; page++) {
      const pageResponse = await request(BASE_URL)
        .get("/logs")
        .query({
          service: tieService,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });

      expect(pageResponse.status).toBe(200);

      const pageBody = pageResponse.body as GetLogsResponse;

      for (const log of pageBody.logs) {
        pagedIds.push(String(log.id));
      }

      cursor = pageBody.next_cursor;
    }

    expect(cursor).toBeNull();
    expect(pagedIds).toEqual(expectedIds);
    expect(new Set(pagedIds).size).toBe(5);
  });

  // 17
  it("uses next_cursor without overlap or skipped logs", async () => {
    const firstResponse = await request(BASE_URL)
      .get("/logs")
      .query({
        service: queryService,
        limit: 10,
      });

    expect(firstResponse.status).toBe(200);

    const first = firstResponse.body as GetLogsResponse;

    expect(first.logs).toHaveLength(10);
    expect(first.next_cursor).toEqual(expect.any(String));

    const secondResponse = await request(BASE_URL)
      .get("/logs")
      .query({
        service: queryService,
        limit: 10,
        cursor: first.next_cursor,
      });

    expect(secondResponse.status).toBe(200);

    const second = secondResponse.body as GetLogsResponse;

    expect(second.logs).toHaveLength(10);

    const firstIds = new Set(
      first.logs.map((log) => String(log.id)),
    );

    for (const log of second.logs) {
      expect(firstIds.has(String(log.id))).toBe(false);
    }

    const expectedFirstTwenty = seededLogs
      .slice(0, 20)
      .map((log) => log.timestamp);

    const actualFirstTwenty = [...first.logs, ...second.logs].map(
      (log) => log.timestamp,
    );

    expect(actualFirstTwenty).toEqual(expectedFirstTwenty);
  });

  // 18
  it("traverses the entire result set exactly once and returns null cursor on the last page", async () => {
    const expectedResponse = await request(BASE_URL)
      .get("/logs")
      .query({
        service: queryService,
        limit: 1000,
      });

    expect(expectedResponse.status).toBe(200);

    const expectedIds = (
      expectedResponse.body as GetLogsResponse
    ).logs.map((log) => String(log.id));

    const traversedIds: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 20; page++) {
      const response = await request(BASE_URL)
        .get("/logs")
        .query({
          service: queryService,
          limit: 17,
          ...(cursor ? { cursor } : {}),
        });

      expect(response.status).toBe(200);

      const body = response.body as GetLogsResponse;

      for (const log of body.logs) {
        traversedIds.push(String(log.id));
      }

      cursor = body.next_cursor;

      if (cursor === null) {
        break;
      }
    }

    expect(cursor).toBeNull();
    expect(traversedIds).toHaveLength(seededLogs.length);
    expect(new Set(traversedIds).size).toBe(seededLogs.length);
    expect(traversedIds).toEqual(expectedIds);
  });

  // 19
  it("accepts the maximum limit and rejects invalid limits", async () => {
    const maxLimitResponse = await request(BASE_URL)
      .get("/logs")
      .query({
        service: queryService,
        limit: 1000,
      });

    expect(maxLimitResponse.status).toBe(200);
    expect(maxLimitResponse.body.logs).toHaveLength(
      seededLogs.length,
    );

    const invalidLimits = ["abc", "0", "1001", "-1", "3.5"];

    for (const limit of invalidLimits) {
      const response = await request(BASE_URL)
        .get("/logs")
        .query({ limit });

      expect(
        response.status,
        `limit=${limit} should be rejected`,
      ).toBe(400);
      expect(typeof response.body.error).toBe("string");
    }
  });

  // 20
  it("returns 400 for every invalid timestamp, range, level, or cursor parameter", async () => {
    const since = new Date(baseTime).toISOString();
    const earlierUntil = new Date(
      baseTime - 60_000,
    ).toISOString();

    const invalidQueries: Record<string, string>[] = [
      { since: "not-a-timestamp" },
      { until: "definitely-not-iso" },
      { since, until: earlierUntil },
      { level: "critical" },
      { service: "" },
      { "attr.": "42" },
      { cursor: "this-is-not-a-valid-cursor!!!" },
    ];

    for (const query of invalidQueries) {
      const response = await request(BASE_URL)
        .get("/logs")
        .query(query);

      expectInvalidGetResponse(response);
    }
  });
});
