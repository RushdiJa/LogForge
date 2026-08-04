import request from "supertest";
import { describe, expect, it } from "vitest";

const BASE_URL = "http://localhost:8080";

describe("GET /health", () => {
  it("returns 200 when the running service is healthy", async () => {
    const response = await request(BASE_URL).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
    });
  });
});