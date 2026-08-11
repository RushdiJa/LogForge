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

type ProfileName =
  | "load"
  | "stress"
  | "spike"
  | "breakpoint";

type Stage = {
  name: string;
  logsPerSecond: number;
  duration: string;
  startTime: string;
  seconds: number;
};

type Profile = {
  name: ProfileName;
  stages: Stage[];
  totalDuration: string;
  totalSeconds: number;
  targetTotalLogs: number;
};

const PROFILES: Record<ProfileName, Profile> = {
  load: {
    name: "load",
    stages: [
      {
        name: "ingestion_load",
        logsPerSecond: 15_000,
        duration: "120s",
        startTime: "0s",
        seconds: 120,
      },
    ],
    totalDuration: "120s",
    totalSeconds: 120,
    targetTotalLogs: 1_800_000,
  },

  stress: {
    name: "stress",
    stages: [
      {
        name: "ingestion_stress_1",
        logsPerSecond: 15_000,
        duration: "30s",
        startTime: "0s",
        seconds: 30,
      },
      {
        name: "ingestion_stress_2",
        logsPerSecond: 22_500,
        duration: "60s",
        startTime: "30s",
        seconds: 60,
      },
      {
        name: "ingestion_stress_3",
        logsPerSecond: 30_000,
        duration: "60s",
        startTime: "90s",
        seconds: 60,
      },
    ],
    totalDuration: "150s",
    totalSeconds: 150,
    targetTotalLogs: 3_600_000,
  },

  spike: {
    name: "spike",
    stages: [
      {
        name: "ingestion_spike_1",
        logsPerSecond: 7_500,
        duration: "30s",
        startTime: "0s",
        seconds: 30,
      },
      {
        name: "ingestion_spike_2",
        logsPerSecond: 30_000,
        duration: "10s",
        startTime: "30s",
        seconds: 10,
      },
      {
        name: "ingestion_spike_3",
        logsPerSecond: 7_500,
        duration: "60s",
        startTime: "40s",
        seconds: 60,
      },
    ],
    totalDuration: "100s",
    totalSeconds: 100,
    targetTotalLogs: 975_000,
  },

  breakpoint: {
    name: "breakpoint",
    stages: [
      {
        name: "ingestion_breakpoint_1",
        logsPerSecond: 15_000,
        duration: "30s",
        startTime: "0s",
        seconds: 30,
      },
      {
        name: "ingestion_breakpoint_2",
        logsPerSecond: 22_500,
        duration: "30s",
        startTime: "30s",
        seconds: 30,
      },
      {
        name: "ingestion_breakpoint_3",
        logsPerSecond: 30_000,
        duration: "30s",
        startTime: "60s",
        seconds: 30,
      },
      {
        name: "ingestion_breakpoint_4",
        logsPerSecond: 45_000,
        duration: "30s",
        startTime: "90s",
        seconds: 30,
      },
    ],
    totalDuration: "120s",
    totalSeconds: 120,
    targetTotalLogs: 3_375_000,
  },
};

const requestedProfile =
  (__ENV.PROFILE ?? "load") as ProfileName;

const PROFILE =
  PROFILES[requestedProfile] ??
  PROFILES.load;

/*
 * Foothill's exact hidden batch size is not published.
 * 40 is a closer reproduction of the request count visible
 * in the benchmark report than the old local default of 100.
 */
const BATCH_SIZE = Number(
  __ENV.BATCH_SIZE ?? "40",
);

const QUERY_RPS = Number(
  __ENV.QUERY_RPS ?? "10",
);

const QUERY_LIMIT = Number(
  __ENV.QUERY_LIMIT ?? "100",
);

const QUERY_P95_TARGET_MS = Number(
  __ENV.QUERY_P95_TARGET_MS ?? "1000",
);

const AGGREGATION_RPS = Number(
  __ENV.AGGREGATION_RPS ?? "1",
);

const VISIBILITY_LIMIT_MS = Number(
  __ENV.VISIBILITY_LIMIT_MS ?? "20000",
);

const VISIBILITY_POLL_SECONDS = Number(
  __ENV.VISIBILITY_POLL_SECONDS ?? "1",
);

const ingestedLogs =
  new Counter("ingested_logs");

const failedIngestionRequests =
  new Rate("failed_ingestion_requests");

const ingestionDuration =
  new Trend("ingestion_duration", true);

const failedQueryRequests =
  new Rate("failed_query_requests");

const queryDuration =
  new Trend("query_duration", true);

const failedAggregationRequests =
  new Rate("failed_aggregation_requests");

const aggregationDuration =
  new Trend("aggregation_duration", true);

const aggregationRequests =
  new Counter("aggregation_requests");

const visibilitySuccess =
  new Rate("visibility_success");

const visibilityDuration =
  new Trend("visibility_duration", true);

const visibilityProbes =
  new Counter("visibility_probes");

const failedHealthChecks =
  new Rate("failed_health_checks");

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

function stageRps(
  stage: Stage,
): number {
  return Math.ceil(
    stage.logsPerSecond /
      BATCH_SIZE,
  );
}

const scenarioRates =
  new Map<string, number>();

function buildIngestionScenarios(): Record<
  string,
  object
> {
  const scenarios: Record<string, object> = {};

  for (const stage of PROFILE.stages) {
    const rate = stageRps(stage);

    scenarioRates.set(
      stage.name,
      rate,
    );

    scenarios[stage.name] = {
      executor:
        "constant-arrival-rate",

      exec:
        "ingestLogs",

      startTime:
        stage.startTime,

      rate,

      timeUnit:
        "1s",

      duration:
        stage.duration,

      /*
       * Foothill-like tests can require many simultaneous
       * requests when latency increases, especially with
       * smaller request batches.
       */
      preAllocatedVUs:
        Math.min(
          Math.max(rate, 300),
          1500,
        ),

      maxVUs:
        5000,

      gracefulStop:
        "30s",
    };
  }

  return scenarios;
}

export const options = {
  scenarios: {
    ...buildIngestionScenarios(),

    normal_queries: {
      executor:
        "constant-arrival-rate",

      exec:
        "queryLogs",

      startTime:
        "0s",

      rate:
        QUERY_RPS,

      timeUnit:
        "1s",

      duration:
        PROFILE.totalDuration,

      preAllocatedVUs:
        50,

      maxVUs:
        500,

      gracefulStop:
        "15s",
    },

    aggregation: {
      executor:
        "constant-arrival-rate",

      exec:
        "aggregateLogs",

      startTime:
        "0s",

      rate:
        AGGREGATION_RPS,

      timeUnit:
        "1s",

      duration:
        PROFILE.totalDuration,

      preAllocatedVUs:
        20,

      maxVUs:
        200,

      gracefulStop:
        "15s",
    },

    health_watch: {
      executor:
        "constant-arrival-rate",

      exec:
        "watchHealth",

      rate:
        1,

      timeUnit:
        "5s",

      duration:
        PROFILE.totalDuration,

      preAllocatedVUs:
        2,

      maxVUs:
        20,

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

    http_req_failed: [
      "rate==0",
    ],

    dropped_iterations: [
      "count==0",
    ],

    ingested_logs: [
      `count>=${PROFILE.targetTotalLogs}`,
    ],

    query_duration: [
      `p(95)<${QUERY_P95_TARGET_MS}`,
    ],

    aggregation_duration: [
      "p(95)<1000",
    ],

    aggregation_requests: [
      `count>=${AGGREGATION_RPS * PROFILE.totalSeconds}`,
    ],
  },
};

export function setup(): void {
  const response =
    http.get(
      `${BASE_URL}/health`,
      {
        timeout: "5s",

        tags: {
          endpoint:
            "setup_health",
        },
      },
    );

  const healthy =
    check(
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

function currentScenarioRps(): number {
  return (
    scenarioRates.get(
      exec.scenario.name,
    ) ??
    Math.ceil(
      15_000 /
        BATCH_SIZE,
    )
  );
}

function createBatch(): BatchResult {
  const iteration =
    exec.scenario
      .iterationInTest;

  const ingestionRps =
    currentScenarioRps();

  const shouldProbeVisibility =
    iteration %
      ingestionRps ===
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

    if (
      shouldProbeVisibility &&
      index === 0
    ) {
      timestamp =
        new Date()
          .toISOString();

      service =
        `visibility-${exec.scenario.name}-${iteration}`;

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
        `Performance log ${exec.scenario.name} ${iteration}-${index}`,

      attributes: {
        source:
          "k6",

        region:
          `region-${
            index % 4
          }`,

        request_id:
          `${exec.scenario.name}-${iteration}-${index}`,

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

export function ingestLogs(): void {
  const {
    logs,
    visibilityProbe,
  } = createBatch();

  const visibilityStartedAt =
    Date.now();

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

        timeout:
          "30s",

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

    if (isIngestResponse(parsed)) {
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

      return;
    }

    sleep(
      VISIBILITY_POLL_SECONDS,
    );
  }

  visibilitySuccess.add(
    false,
  );

  visibilityDuration.add(
    Date.now() -
      startedAt,
  );
}

/*
 * Query mix intentionally exercises more of the official API
 * than the old single service+since query.
 */
export function queryLogs(): void {
  const iteration =
    exec.scenario
      .iterationInTest;

  const since =
    new Date(
      Date.now() -
        DAY_MS,
    ).toISOString();

  const queryCase =
    iteration % 5;

  let query = "";

  switch (queryCase) {
    case 0:
      query =
        `service=perf-service-0` +
        `&since=${encodeURIComponent(
          since,
        )}`;
      break;

    case 1:
      query =
        `level=error` +
        `&since=${encodeURIComponent(
          since,
        )}`;
      break;

    case 2:
      query =
        `service=perf-service-0` +
        `&level=debug` +
        `&since=${encodeURIComponent(
          since,
        )}`;
      break;

    case 3:
      /*
       * Substring search. This is the path most likely
       * to expose a missing trigram/search index.
       */
      query =
        `q=${encodeURIComponent(
          "Performance log",
        )}` +
        `&since=${encodeURIComponent(
          since,
        )}`;
      break;

    default:
      query =
        `attr.source=k6` +
        `&since=${encodeURIComponent(
          since,
        )}`;
      break;
  }

  const url =
    `${BASE_URL}/logs?${query}` +
    `&limit=${QUERY_LIMIT}`;

  const response =
    http.get(
      url,
      {
        timeout:
          "10s",

        tags: {
          endpoint:
            `query_case_${queryCase}`,
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
 * Aggregation mix includes both rollup-friendly requests and
 * requests that force the raw fallback (q / attributes).
 */
export function aggregateLogs(): void {
  aggregationRequests.add(1);

  const iteration =
    exec.scenario
      .iterationInTest;

  const now =
    Date.now();

  const since =
    new Date(
      now - MONTH_MS,
    ).toISOString();

  const until =
    new Date(now)
      .toISOString();

  const aggregateCase =
    iteration % 6;

  let extra = "";

  switch (aggregateCase) {
    case 0:
      extra =
        `&bucket=1h` +
        `&group_by=service`;
      break;

    case 1:
      extra =
        `&bucket=1h` +
        `&group_by=level`;
      break;

    case 2:
      extra =
        `&bucket=5m` +
        `&service=perf-service-0` +
        `&group_by=level`;
      break;

    case 3:
      extra =
        `&bucket=1h` +
        `&level=error` +
        `&group_by=service`;
      break;

    case 4:
      /*
       * Raw fallback path.
       */
      extra =
        `&bucket=1h` +
        `&group_by=service` +
        `&q=${encodeURIComponent(
          "Performance log",
        )}`;
      break;

    default:
      /*
       * Raw fallback path.
       */
      extra =
        `&bucket=1h` +
        `&group_by=service` +
        `&attr.source=k6`;
      break;
  }

  const url =
    `${BASE_URL}/logs/aggregate` +
    `?since=${encodeURIComponent(
      since,
    )}` +
    `&until=${encodeURIComponent(
      until,
    )}` +
    extra;

  const response =
    http.get(
      url,
      {
        timeout:
          "15s",

        tags: {
          endpoint:
            `aggregation_case_${aggregateCase}`,
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

function formatNumber(
  value: number,
  decimals = 2,
): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }

  return value.toFixed(
    decimals,
  );
}

export function handleSummary(
  data: SummaryData,
): Record<string, string> {
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

  const queryP95 =
    metricValue(
      data,
      "query_duration",
      "p(95)",
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

  const healthFailureRate =
    metricValue(
      data,
      "failed_health_checks",
      "rate",
    );

  const averageLogsPerSecond =
    ingested /
      PROFILE.totalSeconds;

  const stageDescription =
    PROFILE.stages
      .map(
        (stage) =>
          `${stage.logsPerSecond}/s for ${stage.duration}`,
      )
      .join(" -> ");

  const report = [
    "",
    "============================================================",
    " LOGFORGE FOOTHILL-LIKE PERFORMANCE REPORT",
    "============================================================",
    "",
    `Profile: ${PROFILE.name}`,
    `Stages: ${stageDescription}`,
    `Batch size: ${BATCH_SIZE}`,
    `Normal query rate: ${QUERY_RPS}/sec`,
    `Aggregation rate: ${AGGREGATION_RPS}/sec`,
    `Target attempted logs: ${PROFILE.targetTotalLogs}`,
    "",
    `Accepted logs: ${formatNumber(ingested, 0)}`,
    `Average achieved logs/sec: ${formatNumber(averageLogsPerSecond)}`,
    `Ingestion p95: ${formatNumber(ingestionP95)} ms`,
    `Ingestion failure rate: ${formatNumber(ingestionFailureRate * 100)}%`,
    "",
    `GET p95: ${formatNumber(queryP95)} ms`,
    `Aggregation p95: ${formatNumber(aggregationP95)} ms`,
    `Aggregation requests: ${formatNumber(aggregationCount, 0)}`,
    "",
    `Visibility success: ${formatNumber(visibilityRate * 100)}%`,
    `Worst visibility: ${formatNumber(visibilityMax)} ms`,
    `Health failure rate: ${formatNumber(healthFailureRate * 100)}%`,
    "",
    "Run docker stats in another terminal.",
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
