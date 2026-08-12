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
});
