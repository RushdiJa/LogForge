import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "./config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("queue consumer configuration", () => {
  it("enables the database consumer by default", () => {
    vi.stubEnv("QUEUE_CONSUMER_ENABLED", undefined);
    expect(loadConfig().queueConsumerEnabled).toBe(true);
  });

  it("allows the consumer to be paused explicitly for publisher diagnostics", () => {
    vi.stubEnv("QUEUE_CONSUMER_ENABLED", "false");
    expect(loadConfig().queueConsumerEnabled).toBe(false);
  });

  it("rejects ambiguous values", () => {
    vi.stubEnv("QUEUE_CONSUMER_ENABLED", "0");
    expect(() => loadConfig()).toThrow("QUEUE_CONSUMER_ENABLED must be true or false");
  });

  it("allows at most two database writers", () => {
    vi.stubEnv("QUEUE_WRITE_CONCURRENCY", "2");
    expect(loadConfig().queueWriteConcurrency).toBe(2);

    vi.stubEnv("QUEUE_WRITE_CONCURRENCY", "3");
    expect(() => loadConfig()).toThrow(
      "QUEUE_WRITE_CONCURRENCY must be an integer between 1 and 2",
    );
  });
});
