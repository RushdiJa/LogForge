import request from "supertest";
import { describe, expect, it } from "vitest";

const BASE_URL = "http://localhost:8080";

describe("POST /logs", () => {
  it("accepts a batch containing one valid log", async () => {
    const response = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send({
        logs: [
          {
            timestamp: new Date().toISOString(),
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
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      accepted: 1,
      rejected: [],
    });
  });

  it("accepts valid entries and rejects invalid entries in the same batch", async () => {
    const response = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send({
        logs: [
          {
            timestamp: new Date().toISOString(),
            level: "info",
            service: "auth",
            message: "valid log",
          },
          {
            timestamp: new Date().toISOString(),
            level: "critical",
            service: "auth",
            message: "invalid level",
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(1);
    expect(response.body.rejected).toHaveLength(1);
    expect(response.body.rejected[0]).toEqual({
      index: 1,
      reason: expect.any(String),
    });
  });

  it("returns 400 when all entries are rejected", async () => {
    const futureTimestamp = new Date(
      Date.now() + 6 * 60 * 1000,
    ).toISOString();

    const response = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send({
        logs: [
          {
            timestamp: futureTimestamp,
            level: "critical",
            service: "",
            message: "",
            attributes: {
              nested: {
                value: 1,
              },
            },
          },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body.accepted).toBe(0);
    expect(response.body.rejected).toHaveLength(1);
    expect(response.body.rejected[0]).toEqual({
      index: 0,
      reason: expect.any(String),
    });
  });

  it("returns 400 when the top-level structure is invalid", async () => {
    const response = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send({
        logs: "not-an-array",
      });

    expect(response.status).toBe(400);
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await request(BASE_URL)
      .post("/logs")
      .set("Content-Type", "application/json")
      .send('{"logs": [');

    expect(response.status).toBe(400);
  });
});