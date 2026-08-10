import http from "k6/http";
import { check } from "k6";
import {
  Counter,
  Rate,
  Trend,
} from "k6/metrics";

const BASE_URL =
  __ENV.BASE_URL ??
  "http://localhost:8080";

/*
 * 30 GET requests/sec
 * × 1000 logs/request
 *
 * = 30,000 logs/sec
 */
const QUERY_RPS = Number(
  __ENV.QUERY_RPS ?? "30",
);

const QUERY_LIMIT = Number(
  __ENV.QUERY_LIMIT ?? "1000",
);

const QUERY_DURATION =
  __ENV.QUERY_DURATION ?? "30s";

/*
 * 30,000 logs/sec
 * × 30 seconds
 *
 * = 900,000 logs
 */
const TARGET_QUERIED_LOGS = Number(
  __ENV.TARGET_QUERIED_LOGS ??
    "900000",
);

const DAY_MS =
  24 * 60 * 60 * 1000;

/*
 * =========================
 * METRICS
 * =========================
 */

const queriedLogs =
  new Counter(
    "queried_logs",
  );

const failedQueries =
  new Rate(
    "failed_queries",
  );

const queryDuration =
  new Trend(
    "query_duration",
    true,
  );

/*
 * =========================
 * TYPES
 * =========================
 */

type QueryResponse = {
  logs: unknown[];
  next_cursor: string | null;
};

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isQueryResponse(
  value: unknown,
): value is QueryResponse {
  if (!isRecord(value)) {
    return false;
  }

  if (!Array.isArray(value.logs)) {
    return false;
  }

  return (
    value.next_cursor === null ||
    typeof value.next_cursor ===
      "string"
  );
}

/*
 * =========================
 * K6 OPTIONS
 * =========================
 */

export const options = {
  scenarios: {
    get_logs: {
      executor:
        "constant-arrival-rate",

      exec:
        "queryLogs",

      /*
       * 30 GET requests/sec
       */
      rate:
        QUERY_RPS,

      timeUnit:
        "1s",

      duration:
        QUERY_DURATION,

      /*
       * Start with enough VUs
       * so k6 itself does not
       * become the bottleneck.
       */
      preAllocatedVUs:
        40,

      maxVUs:
        100,

      gracefulStop:
        "10s",
    },
  },

  thresholds: {
    /*
     * Every GET request should
     * succeed.
     */
    failed_queries: [
      "rate==0",
    ],

    /*
     * k6 should not drop
     * scheduled requests.
     */
    dropped_iterations: [
      "count==0",
    ],

    /*
     * GET p95 should stay
     * below 1 second.
     */
    query_duration: [
      "p(95)<1000",
    ],

    /*
     * 30 req/sec
     * × 1000 logs
     * × 30 sec
     *
     * = 900,000 logs
     */
    queried_logs: [
      `count>=${TARGET_QUERIED_LOGS}`,
    ],
  },
};

/*
 * =========================
 * SETUP
 * =========================
 */

export function setup(): void {
  const response =
    http.get(
      `${BASE_URL}/health`,
    );

  const healthy =
    check(
      response,
      {
        "service is healthy":
          (res) =>
            res.status === 200,
      },
    );

  if (!healthy) {
    throw new Error(
      [
        "Service is not healthy.",
        `status=${response.status}`,
        `body=${response.body}`,
      ].join(" "),
    );
  }
}

/*
 * =========================
 * GET /logs
 * =========================
 */

export function queryLogs(): void {
  const since =
    new Date(
      Date.now() - DAY_MS,
    ).toISOString();

  const url =
    `${BASE_URL}/logs` +
    `?since=${encodeURIComponent(
      since,
    )}` +
    `&limit=${QUERY_LIMIT}`;

  const response =
    http.get(
      url,
      {
        timeout:
          "10s",

        tags: {
          endpoint:
            "get_logs",
        },
      },
    );

  queryDuration.add(
    response.timings.duration,
  );

  let body:
    | QueryResponse
    | undefined;

  try {
    const parsed:
      unknown =
        response.json();

    if (
      isQueryResponse(
        parsed,
      )
    ) {
      body =
        parsed;
    }
  } catch {
    body =
      undefined;
  }

  check(
    response,
    {
      "GET /logs returns 200":
        () =>
          response.status === 200,

      "GET /logs body is valid":
        () =>
          body !== undefined,

      "GET /logs returns full page":
        () =>
          body !== undefined &&
          body.logs.length ===
            QUERY_LIMIT,
    },
  );

  if (
    response.status !== 200 ||
    body === undefined ||
    body.logs.length !==
      QUERY_LIMIT
  ) {
    failedQueries.add(
      true,
    );

    return;
  }

  failedQueries.add(
    false,
  );

  queriedLogs.add(
    body.logs.length,
  );
}