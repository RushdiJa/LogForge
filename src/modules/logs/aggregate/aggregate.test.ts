import { describe, expect, it, vi } from "vitest";

import type { Database } from "../../../db/client.js";
import { AggregateRepository } from "./aggregate.repository.js";
import { validateAggregateQuery } from "./aggregate.validate.js";

describe("aggregate query validation", () => {
  it("accepts all supported bucket and group values", () => {
    for (const bucket of ["1m", "5m", "1h", "1d"]) {
      expect(
        validateAggregateQuery({
          since: "2026-07-20T14:00:00Z",
          until: "2026-07-20T15:00:00Z",
          bucket,
          group_by: "service",
        }).bucket,
      ).toBe(bucket);
    }
  });

  it("requires a valid range and bucket", () => {
    expect(() => validateAggregateQuery({ bucket: "1m" })).toThrow("since and until");
    expect(() =>
      validateAggregateQuery({
        since: "2026-07-20T14:00:00Z",
        until: "2026-07-20T15:00:00Z",
        bucket: "30s",
      }),
    ).toThrow("bucket must be one of");
  });

  it("rejects unsupported parameters", () => {
    expect(() =>
      validateAggregateQuery({
        since: "2026-07-20T14:00:00Z",
        until: "2026-07-20T15:00:00Z",
        bucket: "1m",
        cursor: "nope",
      }),
    ).toThrow("unknown query parameter");
  });
});

describe("aggregate query routing", () => {
  it("uses one-minute rollups for aligned queries", async () => {
    const unsafe = vi.fn().mockResolvedValue([]);
    const repository = new AggregateRepository({ unsafe } as unknown as Database);

    await repository.aggregate({
      since: "2026-07-20T14:00:00.000Z",
      until: "2026-07-20T15:00:00.000Z",
      bucket: "1m",
      attributes: {},
    });

    expect(unsafe.mock.calls[0]?.[0]).toContain("FROM log_rollups_1m r");
  });

  it("serializes a PostgreSQL string bucket start as ISO 8601", async () => {
    const unsafe = vi.fn().mockResolvedValue([
      {
        start: "2026-08-12 14:30:00+00",
        group_value: "api",
        count: "25",
      },
    ]);
    const repository = new AggregateRepository({ unsafe } as unknown as Database);

    const buckets = await repository.aggregate({
      since: "2026-08-12T14:00:00.000Z",
      until: "2026-08-12T15:00:00.000Z",
      bucket: "1m",
      groupBy: "service",
      attributes: {},
    });

    expect(buckets).toEqual([
      { start: "2026-08-12T14:30:00.000Z", group: "api", count: 25 },
    ]);
  });

  it("uses raw logs when a range contains partial minutes", async () => {
    const unsafe = vi.fn().mockResolvedValue([]);
    const repository = new AggregateRepository({ unsafe } as unknown as Database);

    await repository.aggregate({
      since: "2026-07-20T14:00:00.001Z",
      until: "2026-07-20T15:00:00.000Z",
      bucket: "1m",
      attributes: {},
    });

    expect(unsafe.mock.calls[0]?.[0]).toContain("FROM logs l");
  });
});
