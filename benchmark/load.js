import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:8080";
const TARGET_LPS = Number(__ENV.TARGET_LPS || 30000);
const BATCH_SIZE = Number(__ENV.BATCH_SIZE || 500);
const DURATION = __ENV.DURATION || "300s";
const SERVICE_COUNT = Number(__ENV.SERVICE_COUNT || 20);
const PUBLISHER_ONLY = (__ENV.PUBLISHER_ONLY || "false") === "true";

if (
  __ENV.PUBLISHER_ONLY !== undefined &&
  __ENV.PUBLISHER_ONLY !== "true" &&
  __ENV.PUBLISHER_ONLY !== "false"
) {
  throw new Error("PUBLISHER_ONLY must be true or false");
}

const VISIBILITY_TIMEOUT_MS = Number(
  __ENV.VISIBILITY_TIMEOUT_MS || 20000,
);

const FINAL_DRAIN_TIMEOUT_MS = Number(
  __ENV.FINAL_DRAIN_TIMEOUT_MS || 20000,
);

const POLL_INTERVAL_MS = Number(__ENV.POLL_INTERVAL_MS || 250);

function durationSeconds(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value);

  if (match === null) {
    throw new Error(`unsupported DURATION value: ${value}`);
  }

  const amount = Number(match[1]);

  const multipliers = {
    ms: 0.001,
    s: 1,
    m: 60,
    h: 3600,
  };

  return amount * multipliers[match[2]];
}

function positiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

positiveInteger("TARGET_LPS", TARGET_LPS);
positiveInteger("BATCH_SIZE", BATCH_SIZE);
positiveInteger("SERVICE_COUNT", SERVICE_COUNT);
positiveInteger("VISIBILITY_TIMEOUT_MS", VISIBILITY_TIMEOUT_MS);
positiveInteger("FINAL_DRAIN_TIMEOUT_MS", FINAL_DRAIN_TIMEOUT_MS);
positiveInteger("POLL_INTERVAL_MS", POLL_INTERVAL_MS);

if (TARGET_LPS % BATCH_SIZE !== 0) {
  throw new Error(
    "TARGET_LPS must be exactly divisible by BATCH_SIZE",
  );
}

const DURATION_SECONDS = durationSeconds(DURATION);

const INGEST_REQUESTS_PER_SECOND =
  TARGET_LPS / BATCH_SIZE;

const EXPECTED_INGEST_ITERATIONS =
  INGEST_REQUESTS_PER_SECOND * DURATION_SECONDS;

const EXPECTED_ACCEPTED_LOGS =
  TARGET_LPS * DURATION_SECONDS;

if (
  !Number.isInteger(EXPECTED_INGEST_ITERATIONS) ||
  !Number.isInteger(EXPECTED_ACCEPTED_LOGS)
) {
  throw new Error(
    "DURATION must produce an integer number of requests and logs",
  );
}

const acceptedLogs = new Counter("accepted_logs");
const completedIngestionRequests = new Counter(
  "completed_ingestion_requests",
);
const postSuccess = new Rate("post_success");
const postTimeouts = new Counter("post_timeouts");

const queryLatency = new Trend("query_latency", true);
const querySuccess = new Rate("query_success");
const queryTimeouts = new Counter("query_timeouts");

const aggregateLatency = new Trend(
  "aggregate_latency",
  true,
);

const aggregateSuccess = new Rate(
  "aggregate_success",
);
const aggregateTimeouts = new Counter(
  "aggregate_timeouts",
);

const visibilityLatency = new Trend(
  "visibility_latency",
  true,
);

const visibilitySuccess = new Rate(
  "visibility_success",
);
const visibilityTimeouts = new Counter(
  "visibility_timeouts",
);

const finalDrainLatency = new Trend(
  "final_drain_latency",
  true,
);

const finalDrainSuccess = new Rate(
  "final_drain_success",
);

const finalDrainCountKnown = new Rate(
  "final_drain_count_known",
);

const persistedIngestionLogs = new Counter(
  "persisted_ingestion_logs",
);

export const options = {
  discardResponseBodies: false,

  summaryTrendStats: [
    "avg",
    "min",
    "med",
    "max",
    "p(90)",
    "p(95)",
    "p(99)",
  ],

  scenarios: {
    ingestion: {
      executor: "constant-arrival-rate",
      exec: "ingest",
      rate: INGEST_REQUESTS_PER_SECOND,
      timeUnit: "1s",
      duration: DURATION,

      preAllocatedVUs: Math.max(
        60,
        INGEST_REQUESTS_PER_SECOND * 2,
      ),

      maxVUs: Math.max(
        240,
        INGEST_REQUESTS_PER_SECOND * 6,
      ),

      gracefulStop: "20s",

      tags: {
        workload: "ingestion",
      },
    },

    ...(PUBLISHER_ONLY
      ? {}
      : {
          aggregation: {
            executor: "constant-arrival-rate",
            exec: "aggregate",
            rate: 1,
            timeUnit: "1s",
            duration: DURATION,
            preAllocatedVUs: 3,
            maxVUs: 20,
            gracefulStop: "5s",

            tags: {
              workload: "aggregation",
            },
          },
        }),

    ...(PUBLISHER_ONLY
      ? {}
      : {
          querying: {
            executor: "constant-arrival-rate",
            exec: "queryLogs",
            rate: 1,
            timeUnit: "1s",
            duration: DURATION,
            preAllocatedVUs: 3,
            maxVUs: 20,
            gracefulStop: "5s",

            tags: {
              workload: "query",
            },
          },
        }),

    ...(PUBLISHER_ONLY
      ? {}
      : {
          visibility: {
            executor: "constant-arrival-rate",
            exec: "checkVisibility",
            rate: 1,
            timeUnit: "10s",
            duration: DURATION,
            preAllocatedVUs: 3,
            maxVUs: 20,
            gracefulStop: "20s",

            tags: {
              workload: "visibility",
            },
          },
        }),
  },

  thresholds: {
    accepted_logs: [
      `count>=${EXPECTED_ACCEPTED_LOGS}`,
    ],

    completed_ingestion_requests: [
      `count>=${EXPECTED_INGEST_ITERATIONS}`,
    ],

    post_success: ["rate==1"],
    post_timeouts: ["count==0"],

    "http_req_duration{endpoint:ingest}": [
      "p(95)<1000",
    ],

    checks: ["rate==1"],

    "iterations{scenario:ingestion}": [
      `count>=${EXPECTED_INGEST_ITERATIONS}`,
    ],

    "dropped_iterations{scenario:ingestion}": ["count==0"],

    ...(PUBLISHER_ONLY ? {} : {
      persisted_ingestion_logs: [
        `count>=${EXPECTED_ACCEPTED_LOGS}`,
      ],
      query_success: ["rate==1"],
      aggregate_success: ["rate==1"],
      visibility_success: ["rate==1"],
      final_drain_success: ["rate==1"],
      final_drain_count_known: ["rate==1"],
      query_timeouts: ["count==0"],
      aggregate_timeouts: ["count==0"],
      visibility_timeouts: ["count==0"],
      query_latency: ["p(95)<1000"],
      aggregate_latency: ["p(95)<1000"],
      visibility_latency: [
        `p(95)<${VISIBILITY_TIMEOUT_MS}`,
        `max<${VISIBILITY_TIMEOUT_MS}`,
      ],
      final_drain_latency: [
        `max<${FINAL_DRAIN_TIMEOUT_MS}`,
      ],
      "dropped_iterations{scenario:aggregation}": ["count==0"],
      "dropped_iterations{scenario:querying}": ["count==0"],
      "dropped_iterations{scenario:visibility}": ["count==0"],
    }),
  },
};

const JSON_HEADERS = {
  "Content-Type": "application/json",
};

const LEVELS = [
  "debug",
  "info",
  "warn",
  "error",
];

let postFailuresLogged = 0;
let queryFailuresLogged = 0;
let aggregateFailuresLogged = 0;

function boundedBody(response) {
  return String(response.body || "")
    .replace(/\s+/g, " ")
    .slice(0, 512);
}

function safeJson(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}

function createRunId() {
  const random = Math.random()
    .toString(36)
    .slice(2, 10);

  return `${Date.now().toString(36)}-${random}`;
}

function makeBatch(
  ingestionServicePrefix,
  generatedAtMs,
) {
  const logs = new Array(BATCH_SIZE);

  for (
    let index = 0;
    index < BATCH_SIZE;
    index += 1
  ) {
    logs[index] = {
      timestamp: new Date(
        generatedAtMs -
          (index % 600) * 1000,
      ).toISOString(),

      level:
        LEVELS[index % LEVELS.length],

      service:
        `${ingestionServicePrefix}-${index % SERVICE_COUNT}`,

      message:
        `benchmark log message ${index % 100}`,

      attributes: {
        region:
          `region-${index % 4}`,

        worker:
          index % 16,

        sampled:
          index % 2 === 0,
      },
    };
  }

  return JSON.stringify({ logs });
}

function aggregateUrl(
  data,
  finalDrain = false,
) {
  const parameters = [
    `since=${encodeURIComponent(data.since)}`,
    `until=${encodeURIComponent(data.until)}`,
    "bucket=1m",
    "group_by=service",
  ];

  if (!finalDrain) {
    parameters.push(
      `service=${encodeURIComponent(
        `${data.ingestionServicePrefix}-0`,
      )}`,
    );
  }

  return (
    `${BASE_URL}/logs/aggregate?` +
    parameters.join("&")
  );
}

export function setup() {
  const readinessDeadline =
    Date.now() + 120000;

  while (Date.now() < readinessDeadline) {
    const response = http.get(
      `${BASE_URL}/health`,
      {
        tags: {
          endpoint: "readiness",
        },
      },
    );

    if (response.status === 200) {
      const generatedAtMs = Date.now();

      const currentMinute =
        Math.floor(
          generatedAtMs / 60000,
        ) * 60000;

      const runId =
        __ENV.RUN_ID || createRunId();

      const ingestionServicePrefix =
        `benchmark-${runId}-ingest`;

      const visibilityService =
        `benchmark-${runId}-visibility`;

      return {
        runId,
        ingestionServicePrefix,
        visibilityService,

        batchPayload: makeBatch(
          ingestionServicePrefix,
          generatedAtMs,
        ),

        since: new Date(
          currentMinute -
            15 * 60 * 1000,
        ).toISOString(),

        until: new Date(
          currentMinute +
            Math.ceil(
              (DURATION_SECONDS + 120) / 60,
            ) *
              60 *
              1000,
        ).toISOString(),

        expectedAcceptedLogs:
          EXPECTED_ACCEPTED_LOGS,
      };
    }

    sleep(1);
  }

  throw new Error(
    "service did not become healthy within 120 seconds",
  );
}

export function ingest(data) {
  const response = http.post(
    `${BASE_URL}/logs`,
    data.batchPayload,
    {
      headers: JSON_HEADERS,

      tags: {
        endpoint: "ingest",
      },

      timeout: "5s",
    },
  );

  const body = safeJson(response);

  completedIngestionRequests.add(1);
  postTimeouts.add(response.status === 0 ? 1 : 0);

  const accepted = Number(
    body?.accepted || 0,
  );

  const rejected =
    Array.isArray(body?.rejected)
      ? body.rejected.length
      : -1;

  const success =
    response.status === 200 &&
    accepted === BATCH_SIZE &&
    rejected === 0;

  postSuccess.add(success);

  if (success) {
    acceptedLogs.add(accepted);
  } else if (postFailuresLogged < 2) {
    postFailuresLogged += 1;

    console.error(
      `POST /logs failed ` +
        `status=${response.status} ` +
        `accepted=${accepted} ` +
        `rejected=${rejected} ` +
        `body=${boundedBody(response)}`,
    );
  }

  check(response, {
    "POST /logs accepted the complete batch":
      () => success,
  });
}

export function aggregate(data) {
  const response = http.get(
    aggregateUrl(data),
    {
      tags: {
        endpoint: "aggregate",
      },

      timeout: "5s",
    },
  );

  const body = safeJson(response);

  aggregateTimeouts.add(
    response.status === 0 ? 1 : 0,
  );

  const success =
    response.status === 200 &&
    Array.isArray(body?.buckets);

  aggregateLatency.add(
    response.timings.duration,
  );

  aggregateSuccess.add(success);

  if (
    !success &&
    aggregateFailuresLogged < 5
  ) {
    aggregateFailuresLogged += 1;

    console.error(
      `GET /logs/aggregate failed ` +
        `status=${response.status} ` +
        `body=${boundedBody(response)}`,
    );
  }

  check(response, {
    "aggregate returns 200 with buckets":
      () => success,
  });
}

export function queryLogs(data) {
  const parameters = [
    `service=${encodeURIComponent(
      `${data.ingestionServicePrefix}-0`,
    )}`,

    `since=${encodeURIComponent(
      data.since,
    )}`,

    `until=${encodeURIComponent(
      data.until,
    )}`,

    "level=debug",
    "limit=100",
  ];

  const response = http.get(
    `${BASE_URL}/logs?${parameters.join("&")}`,
    {
      tags: {
        endpoint: "query",
      },

      timeout: "5s",
    },
  );

  const body = safeJson(response);

  queryTimeouts.add(
    response.status === 0 ? 1 : 0,
  );

  const success =
    response.status === 200 &&
    Array.isArray(body?.logs) &&
    (
      body?.next_cursor === null ||
      typeof body?.next_cursor === "string"
    );

  queryLatency.add(
    response.timings.duration,
  );

  querySuccess.add(success);

  if (
    !success &&
    queryFailuresLogged < 5
  ) {
    queryFailuresLogged += 1;

    console.error(
      `GET /logs failed ` +
        `status=${response.status} ` +
        `body=${boundedBody(response)}`,
    );
  }

  check(response, {
    "query returns a valid log page":
      () => success,
  });
}

export function checkVisibility(data) {
  const marker =
    `visibility-${data.runId}-` +
    `${__VU}-${__ITER}-${Date.now()}`;

  const payload = JSON.stringify({
    logs: [
      {
        timestamp:
          new Date().toISOString(),

        level: "info",

        service:
          data.visibilityService,

        message:
          marker,

        attributes: {
          probe: true,
        },
      },
    ],
  });

  const post = http.post(
    `${BASE_URL}/logs`,
    payload,
    {
      headers: JSON_HEADERS,

      tags: {
        endpoint: "visibility_post",
      },

      timeout: "5s",
    },
  );

  const postBody = safeJson(post);

  visibilityTimeouts.add(
    post.status === 0 ? 1 : 0,
  );

  const postSucceeded =
    post.status === 200 &&
    Number(postBody?.accepted || 0) === 1;

  check(post, {
    "visibility probe was accepted":
      () => postSucceeded,
  });

  if (!postSucceeded) {
    console.error(
      `visibility POST failed ` +
        `status=${post.status} ` +
        `body=${boundedBody(post)}`,
    );

    visibilityLatency.add(
      VISIBILITY_TIMEOUT_MS,
    );

    visibilitySuccess.add(false);

    return;
  }

  const startedAt = Date.now();

  let lastStatus = 0;
  let lastBody = "";
  let failureReported = false;

  while (
    Date.now() - startedAt <
    VISIBILITY_TIMEOUT_MS
  ) {
    const response = http.get(
      `${BASE_URL}/logs?` +
        `q=${encodeURIComponent(marker)}` +
        "&limit=1",
      {
        tags: {
          endpoint: "visibility_get",
        },

        timeout: "5s",
      },
    );

    const responseBody =
      safeJson(response);

    visibilityTimeouts.add(
      response.status === 0 ? 1 : 0,
    );

    const found =
      response.status === 200 &&
      responseBody?.logs?.[0]?.message ===
        marker;

    if (found) {
      visibilityLatency.add(
        Date.now() - startedAt,
      );

      visibilitySuccess.add(true);

      return;
    }

    lastStatus = response.status;
    lastBody = boundedBody(response);

    if (
      response.status !== 200 &&
      !failureReported
    ) {
      failureReported = true;

      console.error(
        `visibility GET failed ` +
          `status=${response.status} ` +
          `body=${lastBody}`,
      );
    }

    sleep(POLL_INTERVAL_MS / 1000);
  }

  console.error(
    `visibility timed out ` +
      `marker=${marker} ` +
      `last_status=${lastStatus} ` +
      `body=${lastBody}`,
  );

  visibilityLatency.add(
    VISIBILITY_TIMEOUT_MS,
  );

  visibilitySuccess.add(false);
}

function countPersistedRunLogs(
  buckets,
  ingestionServicePrefix,
) {
  if (!Array.isArray(buckets)) {
    return 0;
  }

  return buckets.reduce(
    (total, bucket) => {
      const belongsToRun =
        typeof bucket?.group === "string" &&
        bucket.group.startsWith(
          `${ingestionServicePrefix}-`,
        );

      if (!belongsToRun) {
        return total;
      }

      const count = Number(
        bucket?.count || 0,
      );

      return Number.isFinite(count)
        ? total + count
        : total;
    },
    0,
  );
}

export function teardown(data) {
  if (PUBLISHER_ONLY) {
    console.log(
      "publisher-only diagnostic complete; persistence and visibility were not measured",
    );
    return;
  }

  const startedAt = Date.now();

  let persisted = 0;
  let lastStatus = 0;
  let lastBody = "";
  let countKnown = false;

  while (
    Date.now() - startedAt <
    FINAL_DRAIN_TIMEOUT_MS
  ) {
    const response = http.get(
      aggregateUrl(data, true),
      {
        tags: {
          endpoint: "final_drain",
        },

        timeout: "10s",
      },
    );

    lastStatus = response.status;
    lastBody = boundedBody(response);

    const body = safeJson(response);

    if (response.status === 200) {
      countKnown = Array.isArray(body?.buckets);

      if (!countKnown) {
        lastBody = "aggregate response did not contain buckets";
        sleep(POLL_INTERVAL_MS / 1000);
        continue;
      }

      persisted =
        countPersistedRunLogs(
          body?.buckets,
          data.ingestionServicePrefix,
        );

      if (
        persisted >=
        data.expectedAcceptedLogs
      ) {
        const drainMs =
          Date.now() - startedAt;

        persistedIngestionLogs.add(
          persisted,
        );

        finalDrainLatency.add(drainMs);
        finalDrainSuccess.add(true);
        finalDrainCountKnown.add(true);

        console.log(
          `scheduled database drain complete ` +
            `persisted=${persisted} ` +
            `expected=${data.expectedAcceptedLogs} ` +
            `drain_ms=${drainMs}`,
        );

        return;
      }

    }

    sleep(POLL_INTERVAL_MS / 1000);
  }

  const drainMs =
    Date.now() - startedAt;

  if (countKnown) {
    persistedIngestionLogs.add(persisted);
  }

  finalDrainLatency.add(
    drainMs,
  );

  finalDrainSuccess.add(false);
  finalDrainCountKnown.add(countKnown);

  const persistedDescription = countKnown
    ? String(persisted)
    : "UNKNOWN";

  console.error(
    `database drain did not reach scheduled target ` +
      `persisted=${persistedDescription} ` +
      `expected=${data.expectedAcceptedLogs} ` +
      `elapsed_ms=${drainMs} ` +
      `status=${lastStatus} ` +
      `body=${lastBody}`,
  );
}

function metricValue(
  data,
  metricName,
  valueName,
  fallback = 0,
) {
  return (
    data.metrics?.[metricName]
      ?.values?.[valueName] ??
    fallback
  );
}

function formatNumber(
  value,
  digits = 0,
) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return "n/a";
  }

  const fixed = numeric.toFixed(digits);
  const [integerPart, decimalPart] =
    fixed.split(".");
  const formattedInteger = integerPart.replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ",",
  );

  return decimalPart === undefined
    ? formattedInteger
    : `${formattedInteger}.${decimalPart}`;
}

function formatPercent(value) {
  return (
    `${formatNumber(
      Number(value) * 100,
      2,
    )}%`
  );
}

function failedChecks(
  data,
  accepted,
  persisted,
  persistedKnown,
) {
  const failures = [];

  for (
    const [metricName, metric]
    of Object.entries(data.metrics || {})
  ) {
    for (
      const [thresholdName, threshold]
      of Object.entries(
        metric.thresholds || {},
      )
    ) {
      if (!threshold.ok) {
        failures.push(
          `${metricName}: ${thresholdName}`,
        );
      }
    }
  }

  if (persistedKnown && persisted !== accepted) {
    failures.push(
      `persistence consistency: accepted=${accepted}, persisted=${persisted}`,
    );
  }

  return failures;
}

function renderSummary(data) {
  const accepted = metricValue(
    data,
    "accepted_logs",
    "count",
  );

  const persisted = metricValue(
    data,
    "persisted_ingestion_logs",
    "count",
  );

  const persistedKnown =
    metricValue(
      data,
      "final_drain_count_known",
      "rate",
    ) === 1;

  const completedRequests = metricValue(
    data,
    "completed_ingestion_requests",
    "count",
  );

  const droppedIngestionIterations =
    metricValue(
      data,
      "dropped_iterations{scenario:ingestion}",
      "count",
    );

  const persistenceDifference =
    persistedKnown
      ? accepted - persisted
      : null;

  const persistenceStatus =
    PUBLISHER_ONLY
      ? "NOT MEASURED (publisher-only diagnostic)"
      : !persistedKnown
      ? "UNKNOWN (final count query did not complete)"
      : persistenceDifference === 0
      ? "CONSISTENT"
      : persistenceDifference > 0
        ? `MISSING ${formatNumber(persistenceDifference)} ACCEPTED LOGS`
        : `INCONSISTENT OR CONTAMINATED: ${formatNumber(
            -persistenceDifference,
          )} EXCESS LOGS`;

  const schedulingDifference =
    accepted - EXPECTED_ACCEPTED_LOGS;

  const schedulingStatus =
    schedulingDifference === 0
      ? "MET TARGET"
      : schedulingDifference > 0
        ? `EXCEEDED TARGET BY ${formatNumber(schedulingDifference)} LOGS`
        : `BELOW TARGET BY ${formatNumber(-schedulingDifference)} LOGS`;

  /*
   * k6's displayed Counter rate includes graceful-stop
   * and teardown time. Dividing accepted logs by the
   * configured ingestion window gives the actual
   * scheduled-window throughput.
   */
  const actualWindowLps =
    accepted / DURATION_SECONDS;

  const failures = failedChecks(
    data,
    accepted,
    persisted,
    persistedKnown,
  );

  const status =
    PUBLISHER_ONLY
      ? failures.length === 0
        ? "PUBLISHER PATH PASS (NOT END-TO-END)"
        : "PUBLISHER PATH FAIL"
      : failures.length === 0
        ? "PASS"
        : "FAIL";

  const lines = [
    "",
    "============================================================",
    " LogForge benchmark complete",
    "============================================================",

    ` Result:                    ${status}`,

    ` Mode:                      ${PUBLISHER_ONLY ? "publisher-only diagnostic" : "end-to-end"}`,

    ` Target:                    ` +
      `${formatNumber(TARGET_LPS)} logs/s`,

    ` Scheduled duration:        ` +
      `${DURATION} ` +
      `(${formatNumber(DURATION_SECONDS)}s)`,

    ` Batch size:                ` +
      `${formatNumber(BATCH_SIZE)} logs`,

    ` Request rate:              ` +
      `${formatNumber(
        INGEST_REQUESTS_PER_SECOND,
      )} POST/s`,

    "",
    " INGESTION",

    ` Expected scheduled logs:  ` +
      `${formatNumber(EXPECTED_ACCEPTED_LOGS)}`,

    ` Accepted logs:             ` +
      `${formatNumber(accepted)}`,

    ` Scheduling status:         ` +
      `${schedulingStatus}`,

    ` Completed ingestion POSTs: ` +
      `${formatNumber(completedRequests)} / ` +
      `${formatNumber(EXPECTED_INGEST_ITERATIONS)}`,

    ` Actual scheduled-window:   ` +
      `${formatNumber(
        actualWindowLps,
        2,
      )} logs/s`,

    ` POST success:              ` +
      `${formatPercent(
        metricValue(
          data,
          "post_success",
          "rate",
        ),
      )}`,

    ` POST latency p95:          ` +
      `${formatNumber(
        metricValue(
          data,
          "http_req_duration{endpoint:ingest}",
          "p(95)",
        ),
        2,
      )} ms`,

    ` Dropped ingestion iters:   ` +
      `${formatNumber(
        droppedIngestionIterations,
      )}`,

    ` POST timeouts:             ` +
      `${formatNumber(metricValue(data, "post_timeouts", "count"))}`,

    ...(PUBLISHER_ONLY ? [] : [
      "",
      " READ PATH",

      ` GET success:               ` +
        `${formatPercent(
          metricValue(
            data,
            "query_success",
            "rate",
          ),
        )}`,

      ` GET latency p95:           ` +
        `${formatNumber(
          metricValue(
            data,
            "query_latency",
            "p(95)",
          ),
          2,
        )} ms`,

      ` GET timeouts:              ` +
        `${formatNumber(metricValue(data, "query_timeouts", "count"))}`,

      ` Aggregate success:         ` +
        `${formatPercent(
          metricValue(
            data,
            "aggregate_success",
            "rate",
          ),
        )}`,

      ` Aggregate latency p95:     ` +
        `${formatNumber(
          metricValue(
            data,
            "aggregate_latency",
            "p(95)",
          ),
          2,
        )} ms`,

      ` Aggregate timeouts:        ` +
        `${formatNumber(metricValue(data, "aggregate_timeouts", "count"))}`,

      "",
      " EVENTUAL CONSISTENCY",

      ` Visibility success:        ` +
        `${formatPercent(
          metricValue(
            data,
            "visibility_success",
            "rate",
          ),
        )}`,

      ` Visibility latency p95:    ` +
        `${formatNumber(
          metricValue(
            data,
            "visibility_latency",
            "p(95)",
          ),
          2,
        )} ms`,

      ` Worst visibility:          ` +
        `${formatNumber(
          metricValue(
            data,
            "visibility_latency",
            "max",
          ),
          2,
        )} ms`,

      ` Visibility timeouts:       ` +
        `${formatNumber(metricValue(data, "visibility_timeouts", "count"))}`,

      ` Persisted run logs:        ` +
        `${persistedKnown ? formatNumber(persisted) : "UNKNOWN"}`,

      ` Accepted - persisted:      ` +
        `${persistedKnown ? formatNumber(persistenceDifference) : "UNKNOWN"}`,

      ` Persistence status:        ` +
        `${persistenceStatus}`,

      ` Final drain success:       ` +
        `${formatPercent(
          metricValue(
            data,
            "final_drain_success",
            "rate",
          ),
        )}`,

      ` Final drain time:          ` +
        `${formatNumber(
          metricValue(
            data,
            "final_drain_latency",
            "max",
          ),
          2,
        )} ms`,
    ]),

    "",
  ];

  if (failures.length > 0) {
    lines.push(
      " FAILED CHECKS",
    );

    for (const failure of failures) {
      lines.push(` - ${failure}`);
    }

    lines.push("");
  }

  lines.push(
    " Detailed JSON: benchmark-summary.json",
    "============================================================",
    "",
  );

  return lines.join("\n");
}

export function handleSummary(data) {
  const accepted = metricValue(
    data,
    "accepted_logs",
    "count",
  );

  const persisted = metricValue(
    data,
    "persisted_ingestion_logs",
    "count",
  );

  const persistedKnown =
    metricValue(
      data,
      "final_drain_count_known",
      "rate",
    ) === 1;

  const completedRequests = metricValue(
    data,
    "completed_ingestion_requests",
    "count",
  );

  const droppedIngestionIterations =
    metricValue(
      data,
      "dropped_iterations{scenario:ingestion}",
      "count",
    );

  return {
    stdout: renderSummary(data),

    "benchmark-summary.json":
      JSON.stringify(
        {
          benchmark: {
            mode:
              PUBLISHER_ONLY
                ? "publisher-only"
                : "end-to-end",
            targetLogsPerSecond:
              TARGET_LPS,

            batchSize:
              BATCH_SIZE,

            duration:
              DURATION,

            durationSeconds:
              DURATION_SECONDS,

            expectedAcceptedLogs:
              EXPECTED_ACCEPTED_LOGS,

            expectedIngestionRequests:
              EXPECTED_INGEST_ITERATIONS,

            completedIngestionRequests:
              completedRequests,

            droppedIngestionIterations,

            acceptedLogs:
              accepted,

            persistedLogs:
              persistedKnown ? persisted : null,

            acceptedMinusPersisted:
              persistedKnown
                ? accepted - persisted
                : null,

            persistenceConsistent:
              persistedKnown
                ? accepted === persisted
                : null,

            persistedCountKnown:
              persistedKnown,

            schedulingDifference:
              accepted - EXPECTED_ACCEPTED_LOGS,

            schedulingTargetMet:
              accepted >= EXPECTED_ACCEPTED_LOGS,

            measuredScheduledWindowLogsPerSecond:
              accepted /
              DURATION_SECONDS,

            generatedAt:
              new Date().toISOString(),
          },

          result: data,
        },
        null,
        2,
      ),
  };
}
