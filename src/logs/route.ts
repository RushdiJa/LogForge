import type { FastifyInstance } from "fastify";

import { postLogs } from "./controller.js";

export async function logsRoute(
  app: FastifyInstance
): Promise<void> {
  app.post("/logs", postLogs);
}