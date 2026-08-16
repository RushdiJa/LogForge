import { beforeAll, describe, expect, it } from "vitest";

const LOGS_URL = "http://localhost:8080/logs";
const AGGREGATE_URL =
  "http://localhost:8080/logs/aggregate";

const testId = `aggregate-test-${Date.now()}`;
const checkoutService = `${testId}-checkout`;
const authService = `${testId}-auth`;

const fiveMinutes = 5 * 60 * 1000;

const baseTime =
  Math.floor((Date.now() - 10 * 60 * 1000) / fiveMinutes) *
  fiveMinutes;

const since = new Date(baseTime).toISOString();
const until = new Date(baseTime + fiveMinutes).toISOString();

const firstMinute = new Date(baseTime).toISOString();
const secondMinute = new Date(
  baseTime + 60 * 1000,
).toISOString();

interface AggregateResponse {
  buckets: Array<{
    start: string;
    group: string | null;
    count: number;
  }>;
}

async function getAggregate(
  filters: Record<string, string>,
) {
  const query = new URLSearchParams(filters);

  const response = await fetch(
    `${AGGREGATE_URL}?${query}`,
  );

  const body = (await response.json()) as AggregateResponse;

  return { response, body };
}

describe("GET /logs/aggregate", () => {
  beforeAll(async () => {
    const response = await fetch(LOGS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        logs: [
          {
            timestamp: new Date(
              baseTime + 10_000,
            ).toISOString(),
            level: "error",
            service: checkoutService,
            message: "payment declined",
            attributes: {
              test_id: testId,
              region: "eu",
            },
          },
          {
            timestamp: new Date(
              baseTime + 30_000,
            ).toISOString(),
            level: "info",
            service: authService,
            message: "login successful",
            attributes: {
              test_id: testId,
              region: "eu",
            },
          },
          {
            timestamp: new Date(
              baseTime + 70_000,
            ).toISOString(),
            level: "error",
            service: checkoutService,
            message: "payment declined again",
            attributes: {
              test_id: testId,
              region: "us",
            },
          },
          {
            timestamp: new Date(
              baseTime + 80_000,
            ).toISOString(),
            level: "warn",
            service: checkoutService,
            message: "retry scheduled",
            attributes: {
              test_id: testId,
              region: "eu",
            },
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
  });

  it("returns counts for each minute", async () => {
    const { response, body } = await getAggregate({
      since,
      until,
      bucket: "1m",
      "attr.test_id": testId,
    });

    expect(response.status).toBe(200);

    expect(body.buckets).toEqual([
      {
        start: firstMinute,
        group: null,
        count: 2,
      },
      {
        start: secondMinute,
        group: null,
        count: 2,
      },
    ]);
  });

  it("groups results by service", async () => {
    const { response, body } = await getAggregate({
      since,
      until,
      bucket: "1m",
      group_by: "service",
      "attr.test_id": testId,
    });

    expect(response.status).toBe(200);
    expect(body.buckets).toHaveLength(3);

    expect(body.buckets).toEqual(
      expect.arrayContaining([
        {
          start: firstMinute,
          group: checkoutService,
          count: 1,
        },
        {
          start: firstMinute,
          group: authService,
          count: 1,
        },
        {
          start: secondMinute,
          group: checkoutService,
          count: 2,
        },
      ]),
    );
  });

  it("supports the common log filters", async () => {
    const { response, body } = await getAggregate({
      since,
      until,
      bucket: "1m",
      service: checkoutService,
      level: "error",
      "attr.test_id": testId,
      "attr.region": "eu",
      q: "declined",
    });

    expect(response.status).toBe(200);

    expect(body.buckets).toEqual([
      {
        start: firstMinute,
        group: null,
        count: 1,
      },
    ]);
  });

  it("supports five-minute buckets", async () => {
    const { response, body } = await getAggregate({
      since,
      until,
      bucket: "5m",
      "attr.test_id": testId,
    });

    expect(response.status).toBe(200);

    expect(body.buckets).toEqual([
      {
        start: since,
        group: null,
        count: 4,
      },
    ]);
  });

  it.each([
    { until, bucket: "1m" },
    { since, bucket: "1m" },
    { since, until },
    { since, until, bucket: "2m" },
    {
      since,
      until,
      bucket: "1m",
      group_by: "message",
    },
    {
      since: until,
      until: since,
      bucket: "1m",
    },
  ] as Record<string, string>[])(
    "rejects invalid filters: %o",
    async (filters) => {
      const { response } = await getAggregate(filters);

      expect(response.status).toBe(400);
    },
  );
});