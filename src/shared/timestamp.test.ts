import { describe, expect, it } from "vitest";

import { toIsoTimestamp } from "./timestamp.js";

describe("toIsoTimestamp", () => {
  it("serializes a Date input", () => {
    expect(toIsoTimestamp(new Date("2026-08-12T14:30:00.123Z"))).toBe(
      "2026-08-12T14:30:00.123Z",
    );
  });

  it("serializes a PostgreSQL-style timestamp string", () => {
    expect(toIsoTimestamp("2026-08-12 14:30:00.123+00")).toBe(
      "2026-08-12T14:30:00.123Z",
    );
  });

  it("canonicalizes an ISO timestamp string", () => {
    expect(toIsoTimestamp("2026-08-12T16:30:00.123+02:00")).toBe(
      "2026-08-12T14:30:00.123Z",
    );
  });

  it("rejects an invalid timestamp", () => {
    expect(() => toIsoTimestamp("not-a-timestamp")).toThrow(
      "PostgreSQL returned an invalid timestamp: not-a-timestamp",
    );
  });
});
