import "dotenv/config";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  eq,
  like,
} from "drizzle-orm";

import { db } from "../../db/index.js";
import { logs } from "../../db/schema.js";

vi.mock(
  "../../config/retention.js",
  () => ({
    getRetentionDays: vi.fn(),
  }),
);

import {
  getRetentionDays,
} from "../../config/retention.js";

import {
  deleteExpiredLogsBatch,
} from "./logs.retention.repository.js";

import {
  runRetentionCleanup,
} from "./logs.retention.service.js";

const DAY_MS =
  24 * 60 * 60 * 1_000;

const TEST_SERVICE_PREFIX =
  "retention-test-";

const mockedGetRetentionDays =
  vi.mocked(getRetentionDays);

async function cleanupTestLogs(): Promise<void> {
  await db
    .delete(logs)
    .where(
      like(
        logs.service,
        `${TEST_SERVICE_PREFIX}%`,
      ),
    );
}

async function insertTestLog(
  service: string,
  timestamp: Date,
): Promise<void> {
  await db
    .insert(logs)
    .values({
      timestamp,
      level: "info",
      service,
      message: "Retention test log",
      attributes: {},
    });
}

async function getLogsForService(
  service: string,
) {
  return db
    .select({
      id: logs.id,
      timestamp: logs.timestamp,
    })
    .from(logs)
    .where(
      eq(
        logs.service,
        service,
      ),
    );
}

beforeEach(async () => {
  await cleanupTestLogs();

  mockedGetRetentionDays
    .mockReset();
});

afterEach(async () => {
  await cleanupTestLogs();
});

describe(
  "log retention",
  () => {
    it(
      "deletes expired logs and keeps recent logs",
      async () => {
        const now =
          Date.now();

        const expiredService =
          `${TEST_SERVICE_PREFIX}expired`;

        const recentService =
          `${TEST_SERVICE_PREFIX}recent`;

        await insertTestLog(
          expiredService,
          new Date(
            now - 31 * DAY_MS,
          ),
        );

        await insertTestLog(
          recentService,
          new Date(
            now - 5 * DAY_MS,
          ),
        );

        const cutoff =
          new Date(
            now - 30 * DAY_MS,
          );

        const deleted =
          await deleteExpiredLogsBatch(
            cutoff,
          );

        expect(
          deleted,
        ).toBe(1);

        const expiredLogs =
          await getLogsForService(
            expiredService,
          );

        const recentLogs =
          await getLogsForService(
            recentService,
          );

        expect(
          expiredLogs,
        ).toHaveLength(0);

        expect(
          recentLogs,
        ).toHaveLength(1);
      },
    );

    it(
      "deletes at most 5000 expired logs per batch",
      async () => {
        const service =
          `${TEST_SERVICE_PREFIX}batch`;

        const expiredTimestamp =
          new Date(
            Date.now() -
              60 * DAY_MS,
          );

        const values =
          Array.from(
            {
              length: 5_001,
            },
            (_, index) => ({
              timestamp:
                expiredTimestamp,

              level:
                "info" as const,

              service,

              message:
                `Expired retention log ${index}`,

              attributes: {},
            }),
          );

        await db
          .insert(logs)
          .values(values);

        const cutoff =
          new Date(
            Date.now() -
              30 * DAY_MS,
          );

        const firstBatch =
          await deleteExpiredLogsBatch(
            cutoff,
          );

        expect(
          firstBatch,
        ).toBe(5_000);

        const remainingAfterFirstBatch =
          await getLogsForService(
            service,
          );

        expect(
          remainingAfterFirstBatch,
        ).toHaveLength(1);

        const secondBatch =
          await deleteExpiredLogsBatch(
            cutoff,
          );

        expect(
          secondBatch,
        ).toBe(1);

        const remainingAfterSecondBatch =
          await getLogsForService(
            service,
          );

        expect(
          remainingAfterSecondBatch,
        ).toHaveLength(0);
      },
    );

    it(
      "uses the configured retention period",
      async () => {
        mockedGetRetentionDays
          .mockReturnValue(7);

        const expiredService =
          `${TEST_SERVICE_PREFIX}configured-expired`;

        const recentService =
          `${TEST_SERVICE_PREFIX}configured-recent`;

        await insertTestLog(
          expiredService,
          new Date(
            Date.now() -
              10 * DAY_MS,
          ),
        );

        await insertTestLog(
          recentService,
          new Date(
            Date.now() -
              3 * DAY_MS,
          ),
        );

        await runRetentionCleanup();

        expect(
          mockedGetRetentionDays,
        ).toHaveBeenCalled();

        const expiredLogs =
          await getLogsForService(
            expiredService,
          );

        const recentLogs =
          await getLogsForService(
            recentService,
          );

        expect(
          expiredLogs,
        ).toHaveLength(0);

        expect(
          recentLogs,
        ).toHaveLength(1);
      },
    );

    it(
      "continues deleting until all expired batches are removed",
      async () => {
        mockedGetRetentionDays
          .mockReturnValue(30);

        const service =
          `${TEST_SERVICE_PREFIX}multiple-batches`;

        const expiredTimestamp =
          new Date(
            Date.now() -
              60 * DAY_MS,
          );

        const values =
          Array.from(
            {
              length: 5_001,
            },
            (_, index) => ({
              timestamp:
                expiredTimestamp,

              level:
                "warn" as const,

              service,

              message:
                `Expired multi-batch log ${index}`,

              attributes: {},
            }),
          );

        await db
          .insert(logs)
          .values(values);

        await runRetentionCleanup();

        const remaining =
          await getLogsForService(
            service,
          );

        expect(
          remaining,
        ).toHaveLength(0);
      },
    );
  },
);