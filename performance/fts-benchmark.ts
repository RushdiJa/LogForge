import http from "k6/http";
import { check, sleep } from "k6";
import exec from "k6/execution";
import { Counter, Rate, Trend } from "k6/metrics";

/*
 * FTS Log Ingestion and Query Service benchmark
 *
 * Run the two phases separately:
 *
 *   k6 run -e MODE=seed fts-benchmark.ts
 *   k6 run -e MODE=benchmark fts-benchmark.ts
 *
 * Bonus throughput runs:
 *
 *   k6 run -e MODE=benchmark -e TARGET_LOGS_PER_SECOND=20000 fts-benchmark.ts
 *   k6 run -e MODE=benchmark -e TARGET_LOGS_PER_SECOND=25000 fts-benchmark.ts
 *
 * Useful overrides:
 *
 *   BASE_URL=http://localhost:8080
 *   BATCH_SIZE=100
 *   TEST_DURATION_SECONDS=120
 *   SEED_LOGS=1000000
 *   QUERY_RPS=1
 */

type Mode = "seed" | "benchmark";

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

type AggregationResponse = {
  buckets: unknown[];
};

type SetupData = {
  benchmarkStartedAt: number;
};

const BASE_URL = __ENV.BASE_URL ?? "http://localhost:8080";
const MODE = (__ENV.MODE ?? "benchmark") as Mode;

const BATCH_SIZE = readPositiveInteger("BATCH_SIZE", 100);
const SEED_LOGS = readPositiveInteger("SEED_LOGS", 1_000_000);
const SEED_VUS = readPositiveInteger("SEED_VUS", 100);
const SEED_MAX_DURATION = __ENV.SEED_MAX_DURATION ?? "15m";

const TARGET_LOGS_PER_SECOND = readPositiveInteger(
  "TARGET_LOGS_PER_SECOND",
  15_000,
);
const TEST_DURATION_SECONDS = readPositiveInteger(
  "TEST_DURATION_SECONDS",
  120,
);
const QUERY_RPS = readPositiveInteger("QUERY_RPS", 1);
const AGGREGATION_RPS = 1;
const QUERY_LIMIT = readPositiveInteger("QUERY_LIMIT", 100);
const QUERY_P95_TARGET_MS = readPositiveNumber("QUERY_P95_TARGET_MS", 1_000);
const AGGREGATION_P95_TARGET_MS = 1_000;
const VISIBILITY_LIMIT_MS = 20_000;
const VISIBILITY_INTERVAL_SECONDS = readPositiveInteger(
  "VISIBILITY_INTERVAL_SECONDS",
  5,
);
const VISIBILITY_POLL_SECONDS = readPositiveNumber(
  "VISIBILITY_POLL_SECONDS",
  0.5,
);

// Twenty-eight days stays safely inside a typical 30-day retention window.
const DAY_MS = 24 * 60 * 60 * 1_000;
const DATA_WINDOW_MS = 28 * DAY_MS;
const TEST_DURATION = `${TEST_DURATION_SECONDS}s`;
const SUMMARY_FILE = __ENV.SUMMARY_FILE ?? `fts-${MODE}-summary.json`;

if (MODE !== "seed" && MODE !== "benchmark") {
  throw new Error(`MODE must be "seed" or "benchmark"; received "${MODE}"`);
}

if (QUERY_LIMIT > 1_000) {
  throw new Error("QUERY_LIMIT must not exceed the API maximum of 1000");
}

if (MODE === "benchmark" && TARGET_LOGS_PER_SECOND % BATCH_SIZE !== 0) {
  throw new Error(
    "TARGET_LOGS_PER_SECOND must be divisible by BATCH_SIZE so the scheduled " +
      "rate is exact and the report is not misleading",
  );
}

const ingestionRequestFailures = new Rate("ingestion_request_failures");
const ingestionDuration = new Trend("ingestion_duration", true);
const attemptedLogs = new Counter("attempted_logs");
const acceptedLogs = new Counter("accepted_logs");
const rejectedLogs = new Counter("rejected_logs");

const queryRequestFailures = new Rate("query_request_failures");
const queryDuration = new Trend("query_duration", true);
const queryRequests = new Counter("query_requests");

const aggregationRequestFailures = new Rate("aggregation_request_failures");
const aggregationDuration = new Trend("aggregation_duration", true);
const aggregationRequests = new Counter("aggregation_requests");

const visibilitySuccess = new Rate("visibility_success");
const visibilityDuration = new Trend("visibility_duration", true);
const visibilityProbes = new Counter("visibility_probes");

const healthCheckFailures = new Rate("health_check_failures");

const ingestionRequestsPerSecond = TARGET_LOGS_PER_SECOND / BATCH_SIZE;
const expectedAcceptedLogs = TARGET_LOGS_PER_SECOND * TEST_DURATION_SECONDS;
const seedIterations = Math.ceil(SEED_LOGS / BATCH_SIZE);
const preAllocatedIngestionVUs = Math.min(
  Math.max(Math.ceil(ingestionRequestsPerSecond / 2), 50),
  1_000,
);
const maxIngestionVUs = Math.max(
  preAllocatedIngestionVUs * 4,
  Math.ceil(ingestionRequestsPerSecond * 2),
  500,
);

const seedOptions = {
  scenarios: {
    seed_database: {
      executor: "shared-iterations",
      exec: "seedDatabase",
      vus: SEED_VUS,
      iterations: seedIterations,
      maxDuration: SEED_MAX_DURATION,
      gracefulStop: "30s",
    },
  },
  thresholds: {
    ingestion_request_failures: ["rate==0"],
    accepted_logs: [`count>=${SEED_LOGS}`],
    rejected_logs: ["count==0"],
    dropped_iterations: ["count==0"],
  },
};

const benchmarkOptions = {
  scenarios: {
    sustained_ingestion: {
      executor: "constant-arrival-rate",
      exec: "ingestLogs",
      rate: ingestionRequestsPerSecond,
      timeUnit: "1s",
      duration: TEST_DURATION,
      preAllocatedVUs: preAllocatedIngestionVUs,
      maxVUs: maxIngestionVUs,
      gracefulStop: "30s",
    },
    primary_aggregation: {
      executor: "constant-arrival-rate",
      exec: "aggregateLogs",
      rate: AGGREGATION_RPS,
      timeUnit: "1s",
      duration: TEST_DURATION,
      preAllocatedVUs: 5,
      maxVUs: 30,
      gracefulStop: "15s",
    },
    concurrent_queries: {
      executor: "constant-arrival-rate",
      exec: "queryLogs",
      rate: QUERY_RPS,
      timeUnit: "1s",
      duration: TEST_DURATION,
      preAllocatedVUs: Math.max(QUERY_RPS * 2, 5),
      maxVUs: Math.max(QUERY_RPS * 10, 30),
      gracefulStop: "15s",
    },
    visibility_probes: {
      executor: "constant-arrival-rate",
      exec: "probeVisibility",
      rate: 1,
      timeUnit: `${VISIBILITY_INTERVAL_SECONDS}s`,
      duration: TEST_DURATION,
      preAllocatedVUs: 5,
      maxVUs: 30,
      gracefulStop: "25s",
    },
    health_watch: {
      executor: "constant-arrival-rate",
      exec: "watchHealth",
      rate: 1,
      timeUnit: "5s",
      duration: TEST_DURATION,
      preAllocatedVUs: 2,
      maxVUs: 10,
      gracefulStop: "5s",
    },
  },
  thresholds: {
    ingestion_request_failures: ["rate==0"],
    accepted_logs: [`count>=${expectedAcceptedLogs}`],
    rejected_logs: ["count==0"],
    dropped_iterations: ["count==0"],
    aggregation_request_failures: ["rate==0"],
    aggregation_duration: [`p(95)<${AGGREGATION_P95_TARGET_MS}`],
    aggregation_requests: [`count>=${TEST_DURATION_SECONDS * AGGREGATION_RPS}`],
    query_request_failures: ["rate==0"],
    query_duration: [`p(95)<${QUERY_P95_TARGET_MS}`],
    visibility_success: ["rate==1"],
    visibility_duration: [`max<=${VISIBILITY_LIMIT_MS}`],
    health_check_failures: ["rate==0"],
  },
};

export const options = {
  ...(MODE === "seed" ? seedOptions : benchmarkOptions),
  discardResponseBodies: false,
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export function setup(): SetupData {
  const deadline = Date.now() + 60_000;
  let lastStatus = 0;

  while (Date.now() < deadline) {
    const response = http.get(`${BASE_URL}/health`, {
      timeout: "5s",
      tags: { endpoint: "setup_health" },
    });
    lastStatus = response.status;

    if (response.status === 200) {
      return { benchmarkStartedAt: Date.now() };
    }

    sleep(1);
  }

  throw new Error(
    `Service did not become healthy within 60 seconds (last status: ${lastStatus})`,
  );
}

export function seedDatabase(): void {
  const iteration = exec.scenario.iterationInTest;
  const firstLogIndex = iteration * BATCH_SIZE;
  const remaining = SEED_LOGS - firstLogIndex;

  if (remaining <= 0) {
    return;
  }

  const size = Math.min(BATCH_SIZE, remaining);
  const now = Date.now();
  const logs = createLogs(size, iteration, (index) => {
    const globalIndex = firstLogIndex + index;
    const age = Math.floor((globalIndex / SEED_LOGS) * DATA_WINDOW_MS);
    return new Date(now - age).toISOString();
  });

  sendIngestionBatch(logs, "seed_ingestion");
}

export function ingestLogs(): void {
  const iteration = exec.scenario.iterationInTest;
  const createdAt = new Date().toISOString();
  const logs = createLogs(BATCH_SIZE, iteration, () => createdAt);

  sendIngestionBatch(logs, "sustained_ingestion");
}

export function queryLogs(): void {
  queryRequests.add(1);

  const since = new Date(Date.now() - DAY_MS).toISOString();
  const url =
    `${BASE_URL}/logs` +
    `?service=${encodeURIComponent("perf-service-0")}` +
    "&level=error" +
    `&since=${encodeURIComponent(since)}` +
    `&limit=${QUERY_LIMIT}`;

  const response = http.get(url, {
    timeout: "10s",
    tags: { endpoint: "concurrent_query" },
  });
  queryDuration.add(response.timings.duration);

  const body = parseJson(response.body);
  const succeeded = response.status === 200 && isQueryResponse(body);

  queryRequestFailures.add(!succeeded);
  check(response, {
    "GET /logs succeeds during ingestion": () => succeeded,
  });
}

export function aggregateLogs(): void {
  aggregationRequests.add(1);

  const now = Date.now();
  const since = new Date(now - DATA_WINDOW_MS).toISOString();
  const until = new Date(now + 1_000).toISOString();
  const url =
    `${BASE_URL}/logs/aggregate` +
    `?since=${encodeURIComponent(since)}` +
    `&until=${encodeURIComponent(until)}` +
    "&bucket=1h" +
    "&group_by=service";

  const response = http.get(url, {
    timeout: "10s",
    tags: { endpoint: "primary_aggregation" },
  });
  aggregationDuration.add(response.timings.duration);

  const body = parseJson(response.body);
  const succeeded = response.status === 200 && isAggregationResponse(body);

  aggregationRequestFailures.add(!succeeded);
  check(response, {
    "primary aggregation succeeds during ingestion": () => succeeded,
  });
}

export function probeVisibility(): void {
  visibilityProbes.add(1);

  const uniqueId = `${Date.now()}-${__VU}-${exec.scenario.iterationInTest}`;
  const service = `visibility-${uniqueId}`;
  const timestamp = new Date().toISOString();
  const log = {
    timestamp,
    level: "info",
    service,
    message: `Visibility probe ${uniqueId}`,
    attributes: {
      source: "k6-visibility",
      probe_id: uniqueId,
    },
  };
  const startedAt = Date.now();
  const ingestResponse = http.post(
    `${BASE_URL}/logs`,
    JSON.stringify({ logs: [log] }),
    {
      headers: { "Content-Type": "application/json" },
      timeout: "10s",
      tags: { endpoint: "visibility_ingestion" },
    },
  );

  const ingestBody = parseJson(ingestResponse.body);
  const ingested =
    ingestResponse.status === 200 &&
    isIngestResponse(ingestBody) &&
    ingestBody.accepted === 1 &&
    ingestBody.rejected.length === 0;

  if (!ingested) {
    recordVisibility(false, Date.now() - startedAt);
    return;
  }

  while (Date.now() - startedAt < VISIBILITY_LIMIT_MS) {
    const url =
      `${BASE_URL}/logs` +
      `?service=${encodeURIComponent(service)}` +
      `&since=${encodeURIComponent(timestamp)}` +
      "&limit=1";
    const response = http.get(url, {
      timeout: "5s",
      tags: { endpoint: "visibility_query" },
    });
    const body = parseJson(response.body);
    const visible =
      response.status === 200 && isQueryResponse(body) && body.logs.length === 1;

    if (visible) {
      recordVisibility(true, Date.now() - startedAt);
      return;
    }

    sleep(VISIBILITY_POLL_SECONDS);
  }

  recordVisibility(false, Date.now() - startedAt);
}

export function watchHealth(): void {
  const response = http.get(`${BASE_URL}/health`, {
    timeout: "5s",
    tags: { endpoint: "health_watch" },
  });
  const healthy = response.status === 200;

  healthCheckFailures.add(!healthy);
  check(response, {
    "service stays healthy during ingestion": () => healthy,
  });
}

function createLogs(
  size: number,
  iteration: number,
  timestampFor: (index: number) => string,
): object[] {
  const levels = ["debug", "info", "warn", "error"];
  const logs: object[] = [];

  for (let index = 0; index < size; index++) {
    const sequence = iteration * BATCH_SIZE + index;
    logs.push({
      timestamp: timestampFor(index),
      level: levels[sequence % levels.length],
      service: `perf-service-${sequence % 10}`,
      message: `FTS performance log ${sequence}`,
      attributes: {
        source: "k6",
        region: `region-${sequence % 4}`,
        request_id: `${exec.scenario.name}-${sequence}`,
        attempt: sequence % 5,
        successful: sequence % 2 === 0,
      },
    });
  }

  return logs;
}

function sendIngestionBatch(logs: object[], endpointTag: string): void {
  attemptedLogs.add(logs.length);

  const response = http.post(
    `${BASE_URL}/logs`,
    JSON.stringify({ logs }),
    {
      headers: { "Content-Type": "application/json" },
      timeout: "30s",
      tags: { endpoint: endpointTag },
    },
  );
  ingestionDuration.add(response.timings.duration);

  const body = parseJson(response.body);
  const validBody = isIngestResponse(body);
  const accepted = validBody ? body.accepted : 0;
  const rejected = validBody ? body.rejected.length : logs.length;
  const succeeded =
    response.status === 200 &&
    validBody &&
    accepted === logs.length &&
    rejected === 0;

  acceptedLogs.add(accepted);
  rejectedLogs.add(rejected);
  ingestionRequestFailures.add(!succeeded);

  check(response, {
    "entire ingestion batch is accepted": () => succeeded,
  });
}

function recordVisibility(visible: boolean, elapsedMs: number): void {
  visibilitySuccess.add(visible);
  visibilityDuration.add(elapsedMs);
  check(null, {
    "new log is queryable within 20 seconds": () =>
      visible && elapsedMs <= VISIBILITY_LIMIT_MS,
  });
}

function parseJson(body: string | ArrayBuffer | null): unknown {
  if (typeof body !== "string") {
    return undefined;
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIngestResponse(value: unknown): value is IngestResponse {
  if (!isRecord(value) || typeof value.accepted !== "number") {
    return false;
  }

  if (!Array.isArray(value.rejected)) {
    return false;
  }

  return value.rejected.every(
    (item) =>
      isRecord(item) &&
      typeof item.index === "number" &&
      typeof item.reason === "string",
  );
}

function isQueryResponse(value: unknown): value is QueryResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.logs) &&
    (value.next_cursor === null || typeof value.next_cursor === "string")
  );
}

function isAggregationResponse(value: unknown): value is AggregationResponse {
  return isRecord(value) && Array.isArray(value.buckets);
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = __ENV[name];
  const value = raw === undefined ? fallback : Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer; received "${raw}"`);
  }

  return value;
}

function readPositiveNumber(name: string, fallback: number): number {
  const raw = __ENV[name];
  const value = raw === undefined ? fallback : Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number; received "${raw}"`);
  }

  return value;
}

type SummaryMetric = {
  values?: Record<string, number>;
  thresholds?: Record<string, { ok: boolean }>;
};

type SummaryData = {
  metrics: Record<string, SummaryMetric>;
};

function metricValue(data: SummaryData, metric: string, value: string): number {
  return data.metrics[metric]?.values?.[value] ?? Number.NaN;
}

function format(value: number, decimals = 2): string {
  return Number.isFinite(value) ? value.toFixed(decimals) : "n/a";
}

function percent(value: number): string {
  return Number.isFinite(value) ? `${format(value * 100)}%` : "n/a";
}

function metricThresholdsPassed(metric: SummaryMetric | undefined): boolean {
  if (metric?.thresholds === undefined) {
    return true;
  }

  return Object.values(metric.thresholds).every((threshold) => threshold.ok);
}

function allThresholdsPassed(data: SummaryData): boolean {
  return Object.values(data.metrics).every(metricThresholdsPassed);
}

export function handleSummary(data: SummaryData): Record<string, string> {
  const attempted = metricValue(data, "attempted_logs", "count");
  const accepted = metricValue(data, "accepted_logs", "count");
  const rejected = metricValue(data, "rejected_logs", "count");
  const ingestionFailures = metricValue(data, "ingestion_request_failures", "rate");
  const ingestionP95 = metricValue(data, "ingestion_duration", "p(95)");
  const droppedIterations = metricValue(data, "dropped_iterations", "count");

  const queryCount = metricValue(data, "query_requests", "count");
  const queryP95 = metricValue(data, "query_duration", "p(95)");
  const queryFailures = metricValue(data, "query_request_failures", "rate");

  const aggregationCount = metricValue(data, "aggregation_requests", "count");
  const aggregationP95 = metricValue(data, "aggregation_duration", "p(95)");
  const aggregationFailures = metricValue(
    data,
    "aggregation_request_failures",
    "rate",
  );

  const probeCount = metricValue(data, "visibility_probes", "count");
  const visibilityRate = metricValue(data, "visibility_success", "rate");
  const visibilityMax = metricValue(data, "visibility_duration", "max");
  const healthFailures = metricValue(data, "health_check_failures", "rate");
  const achievedLogsPerSecond =
    MODE === "benchmark" ? accepted / TEST_DURATION_SECONDS : Number.NaN;
  const passed = allThresholdsPassed(data);

  const lines = [
    "",
    "============================================================",
    " FTS LOG SERVICE BENCHMARK REPORT",
    "============================================================",
    `Result: ${passed ? "PASS" : "FAIL"}`,
    `Mode: ${MODE}`,
    `Base URL: ${BASE_URL}`,
    `Batch size: ${BATCH_SIZE}`,
    "",
  ];

  if (MODE === "seed") {
    lines.push(
      `Seed target: ${SEED_LOGS}`,
      `Attempted logs: ${format(attempted, 0)}`,
      `Accepted logs: ${format(accepted, 0)}`,
      `Rejected logs: ${format(rejected, 0)}`,
      `Ingestion request failure rate: ${percent(ingestionFailures)}`,
      `Ingestion request p95: ${format(ingestionP95)} ms`,
      `Dropped generator iterations: ${format(droppedIterations, 0)}`,
    );
  } else {
    lines.push(
      `Target ingestion: ${TARGET_LOGS_PER_SECOND} logs/s for ${TEST_DURATION_SECONDS}s`,
      `Expected accepted logs: ${expectedAcceptedLogs}`,
      `Attempted logs: ${format(attempted, 0)}`,
      `Accepted logs: ${format(accepted, 0)}`,
      `Rejected logs: ${format(rejected, 0)}`,
      `Achieved ingestion: ${format(achievedLogsPerSecond)} logs/s`,
      `Ingestion request p95: ${format(ingestionP95)} ms`,
      `Ingestion request failure rate: ${percent(ingestionFailures)}`,
      `Dropped generator iterations: ${format(droppedIterations, 0)}`,
      "",
      `Primary aggregation requests: ${format(aggregationCount, 0)}`,
      `Primary aggregation p95: ${format(aggregationP95)} ms (target < 1000 ms)`,
      `Aggregation failure rate: ${percent(aggregationFailures)}`,
      "",
      `Concurrent GET requests: ${format(queryCount, 0)}`,
      `Concurrent GET p95: ${format(queryP95)} ms`,
      `GET failure rate: ${percent(queryFailures)}`,
      "",
      `Visibility probes: ${format(probeCount, 0)}`,
      `Visibility success: ${percent(visibilityRate)}`,
      `Worst visibility: ${format(visibilityMax)} ms (target <= 20000 ms)`,
      `Health-check failure rate: ${percent(healthFailures)}`,
    );
  }

  lines.push(
    "",
    "Resource limits must be enforced by docker-compose:",
    "  app: 0.5 CPU / 256 MB RAM",
    "  postgres: 1 CPU / 1 GB RAM",
    "Capture `docker stats` separately for the README evidence.",
    "============================================================",
    "",
  );

  return {
    stdout: lines.join("\n"),
    [SUMMARY_FILE]: JSON.stringify(data, null, 2),
  };
}
