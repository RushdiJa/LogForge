import { beforeAll, describe, expect, it } from "vitest";

const URL = "http://localhost:8080/logs";
const service = `test-${Date.now()}`;

const t1 = new Date(Date.now() - 3000).toISOString();
const t2 = new Date(Date.now() - 2000).toISOString();
const t3 = new Date(Date.now() - 1000).toISOString();

interface GetResponse {
  logs: Array<{
    id: string;
    timestamp: string;
    message: string;
    attributes: Record<string, string>;
  }>;
  next_cursor: string | null;
}

async function getLogs(filters: Record<string, string> = {}) {
  const query = new URLSearchParams(filters);
  const response = await fetch(`${URL}?${query}`);
  const body = (await response.json()) as GetResponse;

  return { response, body };
}

describe("GET /logs", () => {
  beforeAll(async () => {
    const response = await fetch(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        logs: [
          {
            timestamp: t1,
            level: "info",
            service,
            message: "order created",
            attributes: {
              user_id: "42",
              retries: 1,
            },
          },
          {
            timestamp: t2,
            level: "error",
            service,
            message: "payment DECLINED 100%_complete",
            attributes: {
              user_id: "42",
              retries: 3,
            },
          },
          {
            timestamp: t3,
            level: "error",
            service,
            message: "payment declined again",
            attributes: {
              user_id: "99",
              retries: 3,
            },
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
  });

  it("filters by service and sorts newest first", async () => {
    const { response, body } = await getLogs({ service });

    expect(response.status).toBe(200);
    expect(body.logs.map((log) => log.timestamp)).toEqual([
      t3,
      t2,
      t1,
    ]);
  });

  it("combines filters", async () => {
    const { response, body } = await getLogs({
      service,
      level: "error",
      since: t1,
      until: t3,
      "attr.user_id": "42",
      "attr.retries": "3",
      q: "declined",
    });

    expect(response.status).toBe(200);
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.message).toBe(
      "payment DECLINED 100%_complete",
    );
    expect(body.logs[0]?.attributes.retries).toBe("3");
  });

  it("uses inclusive since and exclusive until", async () => {
    const { body } = await getLogs({
      service,
      since: t1,
      until: t3,
    });

    expect(body.logs.map((log) => log.timestamp)).toEqual([
      t2,
      t1,
    ]);
  });

  it("escapes wildcard characters in q", async () => {
    const { body } = await getLogs({
      service,
      q: "%_",
    });

    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.message).toBe(
      "payment DECLINED 100%_complete",
    );
  });

  it("supports cursor pagination", async () => {
    const firstPage = await getLogs({
      service,
      limit: "2",
    });

    expect(firstPage.body.logs).toHaveLength(2);
    expect(firstPage.body.next_cursor).not.toBeNull();

    const secondPage = await getLogs({
      service,
      limit: "2",
      cursor: firstPage.body.next_cursor!,
    });

    expect(secondPage.body.logs).toHaveLength(1);
    expect(secondPage.body.next_cursor).toBeNull();
  });

  it.each([
    { level: "fatal" },
    { since: "invalid" },
    { since: t3, until: t1 },
    { limit: "0" },
    { limit: "1001" },
    { limit: "abc" },
    {
      cursor: Buffer.from("hello").toString("base64url"),
    },
  ] as Record<string, string>[])(
    "rejects invalid filters: %o",
    async (filters) => {
      const { response } = await getLogs(filters);

      expect(response.status).toBe(400);
    },
  );
});