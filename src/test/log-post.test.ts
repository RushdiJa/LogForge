import { describe, expect, it } from "vitest";

describe("POST /logs", () => {
  it("accepts valid logs", async () => {
    const response = await fetch("http://localhost:8080/logs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        logs: [
          {
            timestamp: "2026-07-20T14:32:01.123Z",
            level: "error",
            service: "checkout",
            message: "payment declined",
            attributes: {
              user_id: "42",
              region: "eu-west",
              retries: 3,
            },
          },
        ],
      }),
    });

    expect(response.status).toBe(200);

    expect(await response.json()).toEqual({
      accepted: 1,
      rejected: [],
    });
  });
});