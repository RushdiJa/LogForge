import { describe, expect, it, vi } from "vitest";

import type { Database } from "../../db/client.js";
import { buildWhere, escapeCopyText, LogsRepository } from "./logs.repository.js";
import { LogsService } from "./logs.service.js";
import type { DurableIngestionAcceptor } from "./logs.type.js";
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

  it("uses the normalized message catalog for substring filters", () => {
    const where = buildWhere({ q: "declined%_\\", attributes: {} });

    expect(where.text).toContain("FROM log_message_search message_search");
    expect(where.text).toContain("hashtextextended(message_search.message, 0)");
    expect(where.text).toContain("message_search.message = l.message");
    expect(where.parameters).toEqual(["%declined\\%\\_\\\\%"]);
  });
});

describe("LogsService", () => {
  it("publishes only valid logs and returns rejection indices", async () => {
    const ingestion: DurableIngestionAcceptor = { accept: vi.fn().mockResolvedValue(undefined) };
    const repository = {} as LogsRepository;
    const service = new LogsService(repository, ingestion);

    const result = await service.ingest({ logs: [validLog(), null] });

    expect(result.accepted).toBe(1);
    expect(result.rejected[0]?.index).toBe(1);
    expect(ingestion.accept).toHaveBeenCalledTimes(1);
  });
});

describe("LogsRepository", () => {
  it("encodes every PostgreSQL text COPY control character safely", () => {
    expect(escapeCopyText("tab\tline\nreturn\rslash\\back\bform\fvertical\v")).toBe(
      "tab\\tline\\nreturn\\rslash\\\\back\\bform\\fvertical\\v",
    );
  });

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
    expect(unsafe.mock.calls[0]?.[0]).toContain(
      "ORDER BY l.timestamp DESC NULLS LAST, l.id DESC NULLS LAST",
    );
  });

  it("merges bounded legacy and hot candidates for message searches", async () => {
    const unsafe = vi
      .fn()
      .mockResolvedValueOnce([{ exists: true }])
      .mockResolvedValueOnce([]);
    const repository = new LogsRepository({ unsafe } as unknown as Database);

    await repository.find({
      service: "api",
      q: "needle",
      attributes: { region: "us" },
      limit: 10,
    });

    const [query, parameters] = unsafe.mock.calls[1] as [string, unknown[]];
    expect(query).toContain("FROM logs_legacy l");
    expect(query).toContain("FROM logs_hot_archive l");
    expect(query).toContain("FROM logs_hot l");
    expect(query).toContain("FROM log_legacy_message_search message_catalog_guard");
    expect(query).toContain("FROM log_hot_archive_message_search message_catalog_guard");
    expect(query).toContain("FROM log_message_search message_search");
    expect(query).toContain("l.message ILIKE $2");
    expect(query).toContain("message_catalog_guard.message ILIKE $7");
    expect(query).toContain("message_search.message ILIKE $12");
    expect(parameters).toEqual([
      "api",
      "%needle%",
      "region",
      "us",
      11,
      "api",
      "%needle%",
      "region",
      "us",
      11,
      "api",
      "%needle%",
      "region",
      "us",
      11,
      11,
    ]);
  });

  it("returns an absent substring without scanning any log partition", async () => {
    const unsafe = vi.fn().mockResolvedValueOnce([{ exists: false }]);
    const repository = new LogsRepository({ unsafe } as unknown as Database);

    await expect(repository.find({ q: "new visibility marker", attributes: {}, limit: 1 }))
      .resolves.toEqual([]);

    expect(unsafe).toHaveBeenCalledOnce();
    expect(unsafe.mock.calls[0]?.[0]).toContain("FROM log_message_search");
    expect(unsafe.mock.calls[0]?.[0]).not.toContain("FROM logs_");
  });
});
