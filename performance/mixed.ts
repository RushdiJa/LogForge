import http from "k6/http";
import { check, sleep } from "k6";
import {
  Counter,
  Rate,
  Trend,
} from "k6/metrics";
import exec from "k6/execution";

const BASE_URL =
  __ENV.BASE_URL ?? "http://localhost:8080";

const DAY_MS =
  24 * 60 * 60 * 1000;

const MONTH_MS =
  28 * DAY_MS;

/*
 * ============================================================
 * TARGETS
 * ============================================================
 *
 * Official-like LOAD test:
 *
 *   15,000 logs/sec
 *   100 logs/request
 *   150 POST requests/sec
 *   120 seconds
 *
 *   Total attempted logs:
 *
 *   15,000 * 120
 *   = 1,800,000 logs
 */

const TARGET_LOGS_PER_SECOND = Number(
  __ENV.TARGET_LOGS_PER_SECOND ??
    "15000",
);

const BATCH_SIZE = Number(
  __ENV.BATCH_SIZE ?? "100",
);

const INGESTION_RPS = Math.ceil(
  TARGET_LOGS_PER_SECOND /
    BATCH_SIZE,
);

const INGESTION_DURATION =
  __ENV.INGESTION_DURATION ??
  "120s";

const TARGET_TOTAL_LOGS = Number(
  __ENV.TARGET_TOTAL_LOGS ??
    "1800000",
);

/*
 * ============================================================
 * QUERY SETTINGS
 * ============================================================
 */

const QUERY_RPS = Number(
  __ENV.QUERY_RPS ?? "5",
);

const QUERY_LIMIT = Number(
  __ENV.QUERY_LIMIT ?? "100",
);

const QUERY_P95_TARGET_MS = Number(
  __ENV.QUERY_P95_TARGET_MS ??
    "1000",
);

/*
 * Start queries immediately so reads overlap
 * the whole ingestion test.
 */

const QUERY_START_TIME =
  __ENV.QUERY_START_TIME ??
  "0s";

const QUERY_DURATION =
  __ENV.QUERY_DURATION ??
  "120s";

/*
 * ============================================================
 * AGGREGATION SETTINGS
 * ============================================================
 */

const AGGREGATION_RPS = 1;

const AGGREGATION_EXPECTED_REQUESTS =
  Number(
    __ENV
      .AGGREGATION_EXPECTED_REQUESTS ??
      "120",
  );

/*
 * ============================================================
 * VISIBILITY SETTINGS
 * ============================================================
 */

const VISIBILITY_LIMIT_MS =
  Number(
    __ENV.VISIBILITY_LIMIT_MS ??
      "20000",
  );

const VISIBILITY_POLL_SECONDS =
  Number(
    __ENV
      .VISIBILITY_POLL_SECONDS ??
      "1",
  );

/*
 * ============================================================
 * CUSTOM METRICS
 * ============================================================
 */

const ingestedLogs =
  new Counter(
    "ingested_logs",
  );

const failedIngestionRequests =
  new Rate(
    "failed_ingestion_requests",
  );

const ingestionDuration =
  new Trend(
    "ingestion_duration",
    true,
  );

const failedQueryRequests =
  new Rate(
    "failed_query_requests",
  );

const queryDuration =
  new Trend(
    "query_duration",
    true,
  );

const failedAggregationRequests =
  new Rate(
    "failed_aggregation_requests",
  );

const aggregationDuration =
  new Trend(
    "aggregation_duration",
    true,
  );

const aggregationRequests =
  new Counter(
    "aggregation_requests",
  );

const visibilitySuccess =
  new Rate(
    "visibility_success",
  );

const visibilityDuration =
  new Trend(
    "visibility_duration",
    true,
  );

const visibilityProbes =
  new Counter(
    "visibility_probes",
  );

const failedHealthChecks =
  new Rate(
    "failed_health_checks",
  );

/*
 * ============================================================
 * RESPONSE TYPES
 * ============================================================
 */

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

type VisibilityProbe = {
  service: string;
  timestamp: string;
};

type BatchResult = {
  logs: object[];
  visibilityProbe:
    | VisibilityProbe
    | undefined;
};

/*
 * ============================================================
 * TYPE GUARDS
 * ============================================================
 */

function isRecord(
  value: unknown,
): value is Record<
  string,
  unknown
> {
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
    typeof value.index ===
      "number" &&
    typeof value.reason ===
      "string"
  );
}

function isIngestResponse(
  value: unknown,
): value is IngestResponse {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.accepted !==
      "number" ||
    !Array.isArray(
      value.rejected,
    )
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

  if (
    !Array.isArray(value.logs)
  ) {
    return false;
  }

  return (
    value.next_cursor === null ||
    typeof value.next_cursor ===
      "string"
  );
}

/*
 * ============================================================
 * K6 OPTIONS
 * ============================================================
 */

export const options = {
  scenarios: {
    /*
     * Official-like load:
     *
     * 150 POST/sec
     * *
     * 100 logs/POST
     * =
     * 15,000 logs/sec
     *
     * for 120 seconds.
     */
    ingestion: {
      executor:
        "constant-arrival-rate",

      exec:
        "ingestLogs",

      rate:
        INGESTION_RPS,

      timeUnit:
        "1s",

      duration:
        INGESTION_DURATION,

      /*
       * We intentionally allow many
       * VUs here.
       *
       * If the service becomes slow,
       * k6 must continue attempting
       * the requested arrival rate
       * instead of becoming the
       * bottleneck itself.
       */

      preAllocatedVUs: 300,

      maxVUs: 2000,

      gracefulStop:
        "30s",
    },

    /*
     * Normal GET queries during
     * the entire ingestion period.
     */
    normal_queries: {
      executor:
        "constant-arrival-rate",

      exec:
        "queryLogs",

      startTime:
        QUERY_START_TIME,

      rate:
        QUERY_RPS,

      timeUnit:
        "1s",

      duration:
        QUERY_DURATION,

      preAllocatedVUs: 20,

      maxVUs: 100,

      gracefulStop:
        "15s",
    },

    /*
     * Exactly one aggregation
     * request/sec.
     */
    aggregation: {
      executor:
        "constant-arrival-rate",

      exec:
        "aggregateLogs",

      startTime:
        QUERY_START_TIME,

      rate:
        AGGREGATION_RPS,

      timeUnit:
        "1s",

      duration:
        QUERY_DURATION,

      preAllocatedVUs: 10,

      maxVUs: 50,

      gracefulStop:
        "15s",
    },

    /*
     * Health check every
     * five seconds.
     */
    health_watch: {
      executor:
        "constant-arrival-rate",

      exec:
        "watchHealth",

      rate: 1,

      timeUnit:
        "5s",

      duration:
        INGESTION_DURATION,

      preAllocatedVUs: 2,

      maxVUs: 10,

      gracefulStop:
        "5s",
    },
  },

  thresholds: {
    failed_ingestion_requests: [
      "rate==0",
    ],

    failed_query_requests: [
      "rate==0",
    ],

    failed_aggregation_requests: [
      "rate==0",
    ],

    failed_health_checks: [
      "rate==0",
    ],

    /*
     * The load generator itself
     * must not drop scheduled work.
     */
    dropped_iterations: [
      "count==0",
    ],

    /*
     * No HTTP failures.
     */
    http_req_failed: [
      "rate==0",
    ],

    /*
     * 15k * 120 sec.
     */
    ingested_logs: [
      `count>=${TARGET_TOTAL_LOGS}`,
    ],

    /*
     * Normal GET performance.
     */
    query_duration: [
      `p(95)<${QUERY_P95_TARGET_MS}`,
    ],

    /*
     * Required by project spec.
     */
    aggregation_duration: [
      "p(95)<1000",
    ],

    /*
     * 1/sec for 120 sec.
     */
    aggregation_requests: [
      `count>=${AGGREGATION_EXPECTED_REQUESTS}`,
    ],

    /*
     * Roughly one visibility probe
     * per second.
     */
    visibility_probes: [
      "count>=100",
    ],

    visibility_success: [
      "rate==1",
    ],

    visibility_duration: [
      `max<${VISIBILITY_LIMIT_MS}`,
    ],
  },
};

/*
 * ============================================================
 * SETUP
 * ============================================================
 */

export function setup(): void {
  const response = http.get(
    `${BASE_URL}/health`,
    {
      timeout: "5s",

      tags: {
        endpoint:
          "setup_health",
      },
    },
  );

  const healthy = check(
    response,
    {
      "service is healthy before load":
        (res) =>
          res.status === 200,
    },
  );

  if (!healthy) {
    throw new Error(
      `Service is not healthy before test: status=${response.status}, body=${response.body}`,
    );
  }
}

/*
 * ============================================================
 * CREATE BATCH
 * ============================================================
 *
 * Each batch spreads timestamps
 * over approximately 28 days.
 */

function createBatch(): BatchResult {
  const iteration =
    exec.scenario
      .iterationInTest;

  /*
   * At 150 POST/sec:
   *
   * iteration % 150 === 0
   *
   * gives approximately
   * one probe per second.
   */

  const shouldProbeVisibility =
    iteration %
      INGESTION_RPS ===
    0;

  let visibilityProbe:
    | VisibilityProbe
    | undefined;

  const logs: object[] = [];

  const batchCreatedAt =
    Date.now();

  for (
    let index = 0;
    index < BATCH_SIZE;
    index++
  ) {
    /*
     * Spread logs through
     * a 28-day time range.
     */

    const monthOffset =
      Math.floor(
        (index /
          BATCH_SIZE) *
          MONTH_MS,
      );

    let timestamp =
      new Date(
        batchCreatedAt -
          monthOffset,
      ).toISOString();

    let service =
      `perf-service-${
        index % 10
      }`;

    /*
     * Unique recent log
     * used for read-after-write
     * visibility testing.
     */

    if (
      shouldProbeVisibility &&
      index === 0
    ) {
      timestamp =
        new Date()
          .toISOString();

      service =
        `visibility-probe-${iteration}`;

      visibilityProbe = {
        service,
        timestamp,
      };
    }

    logs.push({
      timestamp,

      level: [
        "debug",
        "info",
        "warn",
        "error",
      ][index % 4],

      service,

      message:
        `Performance log ${iteration}-${index}`,

      attributes: {
        source: "k6",

        region:
          `region-${
            index % 4
          }`,

        request_id:
          `perf-${iteration}-${index}`,

        attempt:
          index % 5,

        successful:
          index % 2 === 0,
      },
    });
  }

  return {
    logs,
    visibilityProbe,
  };
}

/*
 * ============================================================
 * POST /logs
 * ============================================================
 */

export function ingestLogs(): void {
  const {
    logs,
    visibilityProbe,
  } = createBatch();

  /*
   * Visibility timer starts
   * before the POST begins.
   */

  const visibilityStartedAt =
    Date.now();

  const response = http.post(
    `${BASE_URL}/logs`,

    JSON.stringify({
      logs,
    }),

    {
      headers: {
        "Content-Type":
          "application/json",
      },

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
    const parsed: unknown =
      response.json();

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

  check(
    response,
    {
      "entire ingestion batch accepted":
        () => succeeded,
    },
  );

  if (!succeeded) {
    failedIngestionRequests.add(
      true,
    );

    if (
      visibilityProbe !==
      undefined
    ) {
      visibilityProbes.add(1);

      visibilitySuccess.add(
        false,
      );

      visibilityDuration.add(
        Date.now() -
          visibilityStartedAt,
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

  if (
    visibilityProbe !==
    undefined
  ) {
    visibilityProbes.add(1);

    checkVisibility(
      visibilityProbe,
      visibilityStartedAt,
    );
  }
}

/*
 * ============================================================
 * VISIBILITY CHECK
 * ============================================================
 */

function checkVisibility(
  probe: VisibilityProbe,
  startedAt: number,
): void {
  while (
    Date.now() -
      startedAt <
    VISIBILITY_LIMIT_MS
  ) {
    const url =
      `${BASE_URL}/logs` +
      `?service=${encodeURIComponent(
        probe.service,
      )}` +
      `&since=${encodeURIComponent(
        probe.timestamp,
      )}` +
      `&limit=1`;

    const response =
      http.get(
        url,
        {
          timeout:
            "5s",

          tags: {
            endpoint:
              "visibility",
          },
        },
      );

    let body:
      | QueryResponse
      | undefined;

    try {
      const parsed: unknown =
        response.json();

      if (
        isQueryResponse(parsed)
      ) {
        body = parsed;
      }
    } catch {
      body = undefined;
    }

    const elapsed =
      Date.now() -
      startedAt;

    const visible =
      response.status === 200 &&
      body !== undefined &&
      body.logs.length > 0;

    if (visible) {
      visibilitySuccess.add(
        elapsed <
          VISIBILITY_LIMIT_MS,
      );

      visibilityDuration.add(
        elapsed,
      );

      check(
        response,
        {
          "new log visible within 20 seconds":
            () =>
              elapsed <
              VISIBILITY_LIMIT_MS,
        },
      );

      return;
    }

    sleep(
      VISIBILITY_POLL_SECONDS,
    );
  }

  const elapsed =
    Date.now() -
    startedAt;

  visibilitySuccess.add(
    false,
  );

  visibilityDuration.add(
    elapsed,
  );
}

/*
 * ============================================================
 * GET /logs WHILE INGESTION IS ACTIVE
 * ============================================================
 */

export function queryLogs(): void {
  const since =
    new Date(
      Date.now() -
        DAY_MS,
    ).toISOString();

  const url =
    `${BASE_URL}/logs` +
    `?service=perf-service-0` +
    `&since=${encodeURIComponent(
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
            "query",
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
    const parsed: unknown =
      response.json();

    if (
      isQueryResponse(parsed)
    ) {
      body = parsed;
    }
  } catch {
    body = undefined;
  }

  const succeeded =
    response.status === 200 &&
    body !== undefined;

  check(
    response,
    {
      "query succeeds during ingestion":
        () => succeeded,
    },
  );

  failedQueryRequests.add(
    !succeeded,
  );
}

/*
 * ============================================================
 * GET /logs/aggregate
 * ============================================================
 */

export function aggregateLogs(): void {
  aggregationRequests.add(1);

  const now =
    Date.now();

  const since =
    new Date(
      now - MONTH_MS,
    ).toISOString();

  const until =
    new Date(
      now,
    ).toISOString();

  const url =
    `${BASE_URL}/logs/aggregate` +
    `?since=${encodeURIComponent(
      since,
    )}` +
    `&until=${encodeURIComponent(
      until,
    )}` +
    `&bucket=1h` +
    `&group_by=service`;

  const response =
    http.get(
      url,
      {
        timeout:
          "10s",

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

  check(
    response,
    {
      "aggregation succeeds during ingestion":
        () => succeeded,
    },
  );

  failedAggregationRequests.add(
    !succeeded,
  );
}

/*
 * ============================================================
 * HEALTH WATCH
 * ============================================================
 */

export function watchHealth(): void {
  const response =
    http.get(
      `${BASE_URL}/health`,
      {
        timeout:
          "5s",

        tags: {
          endpoint:
            "health_watch",
        },
      },
    );

  const succeeded =
    response.status === 200;

  failedHealthChecks.add(
    !succeeded,
  );

  check(
    response,
    {
      "service remains healthy under load":
        () => succeeded,
    },
  );
}

/*
 * ============================================================
 * CUSTOM PASS / FAIL REPORT
 * ============================================================
 */

type SummaryMetric = {
  values?: Record<
    string,
    number
  >;
};

type SummaryData = {
  metrics: Record<
    string,
    SummaryMetric
  >;
};

function metricValue(
  data: SummaryData,
  metricName: string,
  valueName: string,
): number {
  return (
    data.metrics[
      metricName
    ]?.values?.[
      valueName
    ] ??
    Number.NaN
  );
}

function passFail(
  passed: boolean,
): string {
  return passed
    ? "PASS"
    : "FAIL";
}

function formatNumber(
  value: number,
  decimals = 2,
): string {
  if (
    !Number.isFinite(value)
  ) {
    return "n/a";
  }

  return value.toFixed(
    decimals,
  );
}

export function handleSummary(
  data: SummaryData,
): Record<
  string,
  string
> {
  const ingested =
    metricValue(
      data,
      "ingested_logs",
      "count",
    );

  const ingestionFailureRate =
    metricValue(
      data,
      "failed_ingestion_requests",
      "rate",
    );

  const ingestionP95 =
    metricValue(
      data,
      "ingestion_duration",
      "p(95)",
    );

  const dropped =
    metricValue(
      data,
      "dropped_iterations",
      "count",
    );

  const httpFailureRate =
    metricValue(
      data,
      "http_req_failed",
      "rate",
    );

  const queryFailureRate =
    metricValue(
      data,
      "failed_query_requests",
      "rate",
    );

  const queryP95 =
    metricValue(
      data,
      "query_duration",
      "p(95)",
    );

  const aggregationFailureRate =
    metricValue(
      data,
      "failed_aggregation_requests",
      "rate",
    );

  const aggregationP95 =
    metricValue(
      data,
      "aggregation_duration",
      "p(95)",
    );

  const aggregationCount =
    metricValue(
      data,
      "aggregation_requests",
      "count",
    );

  const visibilityRate =
    metricValue(
      data,
      "visibility_success",
      "rate",
    );

  const visibilityMax =
    metricValue(
      data,
      "visibility_duration",
      "max",
    );

  const visibilityProbeCount =
    metricValue(
      data,
      "visibility_probes",
      "count",
    );

  const healthFailureRate =
    metricValue(
      data,
      "failed_health_checks",
      "rate",
    );

  const ingestionPassed =
    ingested >=
      TARGET_TOTAL_LOGS &&
    ingestionFailureRate ===
      0 &&
    dropped === 0;

  const stabilityPassed =
    dropped === 0 &&
    ingestionFailureRate ===
      0 &&
    httpFailureRate ===
      0 &&
    healthFailureRate ===
      0;

  const queryPassed =
    queryFailureRate === 0 &&
    queryP95 <
      QUERY_P95_TARGET_MS;

  const aggregationPassed =
    aggregationFailureRate ===
      0 &&
    aggregationP95 < 1000;

  const totalLogsPassed =
    ingested >=
    TARGET_TOTAL_LOGS;

  const visibilityPassed =
    visibilityProbeCount >=
      100 &&
    visibilityRate === 1 &&
    visibilityMax <
      VISIBILITY_LIMIT_MS;

  const aggregationRatePassed =
    aggregationCount >=
      AGGREGATION_EXPECTED_REQUESTS &&
    aggregationFailureRate ===
      0;

  /*
   * Actual accepted-log rate,
   * using the configured
   * 120-second load duration.
   */

  const actualLogsPerSecond =
    ingested / 120;

  const report = [
    "",
    "============================================================",
    " LOGFORGE OFFICIAL-LIKE LOAD REPORT",
    "============================================================",
    "",
    "Configuration:",
    `       target logs/sec: ${TARGET_LOGS_PER_SECOND}`,
    `       batch size: ${BATCH_SIZE}`,
    `       POST requests/sec: ${INGESTION_RPS}`,
    `       duration: ${INGESTION_DURATION}`,
    `       target total logs: ${TARGET_TOTAL_LOGS}`,
    "",
    `[${passFail(ingestionPassed)}] Sustain >= ${TARGET_LOGS_PER_SECOND.toLocaleString()} logs/sec`,
    `       accepted logs: ${formatNumber(ingested, 0)}`,
    `       achieved logs/sec: ${formatNumber(actualLogsPerSecond)}`,
    `       ingestion p95: ${formatNumber(ingestionP95)} ms`,
    `       failed ingestion rate: ${formatNumber(ingestionFailureRate * 100)}%`,
    `       dropped iterations: ${formatNumber(dropped, 0)}`,
    "",
    `[${passFail(stabilityPassed)}] No dropped requests / HTTP failures / health failures`,
    `       HTTP failure rate: ${formatNumber(httpFailureRate * 100)}%`,
    `       health failure rate: ${formatNumber(healthFailureRate * 100)}%`,
    "",
    `[${passFail(aggregationPassed)}] Aggregation p95 < 1 second`,
    `       aggregation p95: ${formatNumber(aggregationP95)} ms`,
    "",
    `[${passFail(queryPassed)}] Maintain GET performance during ingestion`,
    `       GET p95: ${formatNumber(queryP95)} ms`,
    `       GET failure rate: ${formatNumber(queryFailureRate * 100)}%`,
    "",
    `[${passFail(totalLogsPassed)}] Handle official-like load volume`,
    `       accepted logs: ${formatNumber(ingested, 0)}`,
    `       expected: >= ${TARGET_TOTAL_LOGS}`,
    "",
    `[${passFail(visibilityPassed)}] New logs queryable within 20 seconds`,
    `       visibility probes: ${formatNumber(visibilityProbeCount, 0)}`,
    `       successful probe rate: ${formatNumber(visibilityRate * 100)}%`,
    `       worst visibility: ${formatNumber(visibilityMax)} ms`,
    "",
    `[${passFail(aggregationRatePassed)}] 1 aggregation request/sec during ingestion`,
    `       aggregation requests: ${formatNumber(aggregationCount, 0)}`,
    `       expected: >= ${AGGREGATION_EXPECTED_REQUESTS}`,
    "",
    "NOTE:",
    "Run `docker stats` in another terminal while this test is running.",
    "",
    "============================================================",
    "",
  ].join("\n");

  return {
    stdout:
      report,

    "performance-summary.json":
      JSON.stringify(
        data,
        null,
        2,
      ),
  };
}