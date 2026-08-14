import type { FastifyInstance } from "fastify";
import { pool } from "./db.js";


export async function health(
  app: FastifyInstance
): Promise<void> {
  app.get("/health", async (_, reply) => {
    try {
      await pool.query("SELECT 1");

      return {
        status: "ok",
      };
    } catch {
      reply.code(503);

      return {
        status: "unavailable",
      };
    }
  });
}