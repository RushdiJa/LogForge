import http from "k6/http";
import { check } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import exec from "k6/execution";

const BASE_URL =
  __ENV.BASE_URL ?? "http://localhost:8080";

const TARGET_LOGS_PER_SECOND = Number(
  __ENV.TARGET_LOGS_PER_SECOND ?? "15000",
);

const BATCH_SIZE = Number(
  __ENV.BATCH_SIZE ?? "500",
);

const QUERY_RPS = Number(
  __ENV.QUERY_RPS ?? "5",
);

const INGESTION_DURATION =
  __ENV.INGESTION_DURATION ?? "67s";

const QUERY_DURATION =
  __ENV.QUERY_DURATION ?? "30s";

const QUERY_START_TIME =
  __ENV.QUERY_START_TIME ?? "100s";

const TARGET_TOTAL_LOGS = Number(
  __ENV.TARGET_TOTAL_LOGS ?? "1000000",
);

const DAY_MS =
  24 * 60 * 60 * 1000;

const INGESTION_REQUESTS_PER_SECOND =
  Math.ceil(
    TARGET_LOGS_PER_SECOND /
      BATCH_SIZE,
  );

const ingestedLogs =
  new Counter("ingested_logs");

const failedIngestionRequests =
  new Rate(
    "failed_ingestion_requests",
  );

const failedQueryRequests =
  new Rate(
    "failed_query_requests",
  );

const ingestionDuration =
  new Trend(
    "ingestion_duration",
    true,
  );

const queryDuration =
  new Trend(
    "query_duration",
    true,
  );

const aggregationDuration =
  new Trend(
    "aggregation_duration",
    true,
  );

type RejectedLog = {
  index: number;
  reason: string;
};

type IngestResponse = {
  accepted: number;
  rejected: RejectedLog[];
};

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

function isRejectedLog(
  value: unknown,
): value is RejectedLog {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.index === "number" &&
    typeof value.reason === "string"
  );
}

function isIngestResponse(
  value: unknown,
): value is IngestResponse {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.accepted !== "number" ||
    !Array.isArray(value.rejected)
  ) {
    return false;
  }

  return value.rejected.every(
    isRejectedLog,
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
    typeof value.next_cursor === "string"
  );
}

export const options = {
  scenarios: {
    /*
     * PHASE 1
     *
     * 30 requests/sec
     * × 500 logs
     * =
     * 15,000 logs/sec
     *
     * 67 seconds:
     * ≈ 1,005,000 logs
     */
    ingestion: {
      executor:
        "constant-arrival-rate",

      exec: "ingestLogs",

      rate:
        INGESTION_REQUESTS_PER_SECOND,

      timeUnit: "1s",

      duration:
        INGESTION_DURATION,

      preAllocatedVUs: 50,

      maxVUs: 200,

      gracefulStop: "30s",
    },

    /*
     * PHASE 2
     *
     * Starts after ingestion
     * has finished / timed out.
     */
    normal_queries: {
      executor:
        "constant-arrival-rate",

      exec: "queryLogs",

      startTime:
        QUERY_START_TIME,

      rate: QUERY_RPS,

      timeUnit: "1s",

      duration:
        QUERY_DURATION,

      preAllocatedVUs: 10,

      maxVUs: 30,
    },

    aggregation: {
      executor:
        "constant-arrival-rate",

      exec: "aggregateLogs",

      startTime:
        QUERY_START_TIME,

      rate: 1,

      timeUnit: "1s",

      duration:
        QUERY_DURATION,

      preAllocatedVUs: 5,

      maxVUs: 20,
    },
  },

  thresholds: {
    failed_ingestion_requests: [
      "rate==0",
    ],

    failed_query_requests: [
      "rate==0",
    ],

    dropped_iterations: [
      "count==0",
    ],

    /*
     * This phased test lasts longer
     * than ingestion itself.
     *
     * Therefore we check the total
     * number of successfully accepted
     * logs instead of Counter rate.
     */
    ingested_logs: [
      `count>=${TARGET_TOTAL_LOGS}`,
    ],

    aggregation_duration: [
      "p(95)<1000",
    ],
  },
};

export function setup(): void {
  const response =
    http.get(
      `${BASE_URL}/health`,
    );

  const healthy =
    check(response, {
      "service is healthy":
        (res) =>
          res.status === 200,
    });

  if (!healthy) {
    throw new Error(
      `Service is not healthy: status=${response.status}, body=${response.body}`,
    );
  }
}

function createBatch(): object[] {
  const timestamp =
    new Date().toISOString();

  const iteration =
    exec.scenario.iterationInTest;

  const logs: object[] = [];

  for (
    let index = 0;
    index < BATCH_SIZE;
    index++
  ) {
    logs.push({
      timestamp,

      level: [
        "debug",
        "info",
        "warn",
        "error",
      ][index % 4],

      service:
        `perf-service-${index % 10}`,

      message:
        `Performance log ${iteration}-${index}`,

      attributes: {
        source: "k6",

        region:
          `region-${index % 4}`,

        request_id:
          `perf-${iteration}-${index}`,

        attempt:
          index % 5,

        successful:
          index % 2 === 0,
      },
    });
  }

  return logs;
}

export function ingestLogs(): void {
  const logs =
    createBatch();

  const response =
    http.post(
      `${BASE_URL}/logs`,

      JSON.stringify({
        logs,
      }),

      {
        headers: {
          "Content-Type":
            "application/json",
        },

        /*
         * POST /logs timeout
         */
        timeout: "30s",

        tags: {
          endpoint:
            "ingestion",
        },
      },
    );

  ingestionDuration.add(
    response.timings.duration,
  );

  let body:
    | IngestResponse
    | undefined;

  try {
    const parsed:
      unknown = response.json();

    if (
      isIngestResponse(parsed)
    ) {
      body = parsed;
    }
  } catch {
    body = undefined;
  }

  const succeeded =
    response.status === 200 &&
    body !== undefined &&
    body.accepted ===
      BATCH_SIZE &&
    body.rejected.length === 0;

  check(response, {
    "entire ingestion batch accepted":
      () => succeeded,
  });

  if (!succeeded) {
    failedIngestionRequests.add(
      true,
    );

    if (
      exec.scenario
        .iterationInTest === 0
    ) {
      console.error(
        [
          "",
          "========== INGESTION FAILURE ==========",
          `status: ${response.status}`,
          `expected accepted: ${BATCH_SIZE}`,
          `response body: ${response.body}`,
          "=======================================",
          "",
        ].join("\n"),
      );
    }

    return;
  }

  failedIngestionRequests.add(
    false,
  );

  ingestedLogs.add(
    BATCH_SIZE,
  );
}

export function queryLogs(): void {
  const since =
    new Date(
      Date.now() - DAY_MS,
    ).toISOString();

  const url =
    `${BASE_URL}/logs` +
    `?service=perf-service-0` +
    `&since=${encodeURIComponent(since)}` +
    `&limit=100`;

  const response =
    http.get(
      url,

      {
        timeout: "10s",

        tags: {
          endpoint: "query",
        },
      },
    );

  queryDuration.add(
    response.timings.duration,
  );

  let validBody = false;

  try {
    const parsed:
      unknown = response.json();

    validBody =
      isQueryResponse(parsed);
  } catch {
    validBody = false;
  }

  const succeeded =
    response.status === 200 &&
    validBody;

  check(response, {
    "query succeeds":
      () => succeeded,
  });

  failedQueryRequests.add(
    !succeeded,
  );
}

export function aggregateLogs(): void {
  const now =
    Date.now();

  const since =
    new Date(
      now - 28 * DAY_MS,
    ).toISOString();

  const until =
    new Date(
      now,
    ).toISOString();

  const url =
    `${BASE_URL}/logs/aggregate` +
    `?since=${encodeURIComponent(since)}` +
    `&until=${encodeURIComponent(until)}` +
    `&bucket=1h` +
    `&group_by=service`;

  const response =
    http.get(
      url,

      {
        timeout: "30s",

        tags: {
          endpoint:
            "aggregation",
        },
      },
    );

  aggregationDuration.add(
    response.timings.duration,
  );

  const succeeded =
    response.status === 200;

  check(response, {
    "aggregation succeeds":
      () => succeeded,
  });

  failedQueryRequests.add(
    !succeeded,
  );
}