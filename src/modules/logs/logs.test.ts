import { describe, expect, it, vi } from "vitest";

import type { Database } from "../../db/client.js";
import { buildWhere, LogsRepository } from "./logs.repository.js";
import { LogsService } from "./logs.service.js";
import type { QueuePublisher } from "./logs.type.js";
import {
  decodeCursor,
  encodeCursor,
  validateIngestRequest,
  validateLogQuery,
} from "./logs.validate.js";

const NOW = Date.parse("2026-07-20T14:30:00.000Z");

function validLog() {
  return {
    timestamp: "2026-07-20T14:29:00.123Z",
    level: "error",
    service: "checkout",
    message: "payment declined",
    attributes: { user_id: "42", retries: 3, cached: false },
  };
}

describe("log ingestion validation", () => {
  it("accepts valid entries and rejects invalid entries independently", () => {
    const result = validateIngestRequest(
      { logs: [validLog(), { ...validLog(), level: "critical" }] },
      NOW,
    );

    expect(result.valid).toHaveLength(1);
    expect(result.rejected).toEqual([
      { index: 1, reason: "invalid level: 'critical'" },
    ]);
  });

  it("rejects timestamps more than five minutes in the future", () => {
    const result = validateIngestRequest(
      { logs: [{ ...validLog(), timestamp: "2026-07-20T14:35:00.001Z" }] },
      NOW,
    );

    expect(result.valid).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain("five minutes");
  });

  it("rejects nested attributes", () => {
    const result = validateIngestRequest(
      { logs: [{ ...validLog(), attributes: { nested: { value: 1 } } }] },
      NOW,
    );

    expect(result.rejected[0]?.reason).toContain("attribute 'nested'");
  });

  it("rejects PostgreSQL-incompatible null bytes before publishing", () => {
    const result = validateIngestRequest(
      { logs: [{ ...validLog(), message: "invalid\0message" }] },
      NOW,
    );

    expect(result.valid).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain("null bytes");
  });

  it("rejects an invalid top-level body", () => {
    expect(() => validateIngestRequest([validLog()], NOW)).toThrow(
      "Request body must have the structure",
    );
  });
});

describe("log query validation", () => {
  it("combines filters, attributes, and the maximum limit", () => {
    const query = validateLogQuery({
      service: "checkout",
      level: "error",
      since: "2026-07-20T14:00:00Z",
      until: "2026-07-20T15:00:00Z",
      "attr.user_id": "42",
      q: "declined",
      limit: "1000",
    });

    expect(query).toMatchObject({
      service: "checkout",
      level: "error",
      attributes: { user_id: "42" },
      q: "declined",
      limit: 1000,
    });
  });

  it("round-trips an opaque cursor", () => {
    const value = { timestamp: "2026-07-20T14:00:00.000Z", id: "9007199254740993" };
    expect(decodeCursor(encodeCursor(value))).toEqual(value);
  });

  it("rejects invalid ranges and cursors", () => {
    expect(() =>
      validateLogQuery({
        since: "2026-07-20T15:00:00Z",
        until: "2026-07-20T14:00:00Z",
      }),
    ).toThrow("since must be earlier");
    expect(() => validateLogQuery({ cursor: "not-a-cursor" })).toThrow("cursor is invalid");
  });

  it("keeps filter values out of generated SQL text", () => {
    const malicious = "checkout' OR TRUE --";
    const where = buildWhere({
      service: malicious,
      attributes: { "key') OR TRUE --": malicious },
    });

    expect(where.text).not.toContain(malicious);
    expect(where.parameters).toContain(malicious);
  });
});

describe("LogsService", () => {
  it("publishes only valid logs and returns rejection indices", async () => {
    const publisher: QueuePublisher = { publish: vi.fn().mockResolvedValue(undefined) };
    const repository = {} as LogsRepository;
    const service = new LogsService(repository, publisher);

    const result = await service.ingest({ logs: [validLog(), null] });

    expect(result.accepted).toBe(1);
    expect(result.rejected[0]?.index).toBe(1);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });
});

describe("LogsRepository", () => {
  it("serializes a PostgreSQL string timestamp as ISO 8601", async () => {
    const unsafe = vi.fn().mockResolvedValue([
      {
        id: "42",
        timestamp: "2026-08-12 14:30:00.123+00",
        level: "info",
        service: "api",
        message: "ready",
        attributes: {},
      },
    ]);
    const repository = new LogsRepository({ unsafe } as unknown as Database);

    const rows = await repository.find({ attributes: {}, limit: 1 });

    expect(rows).toEqual([
      {
        id: "42",
        timestamp: "2026-08-12T14:30:00.123Z",
        level: "info",
        service: "api",
        message: "ready",
        attributes: {},
      },
    ]);
  });
});
