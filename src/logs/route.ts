import type { FastifyInstance } from "fastify";

import { postLogs, getLogs, getLogAggregates} from "./controller.js";

export async function logsRoute(
  app: FastifyInstance
): Promise<void> {
  app.post("/logs", postLogs);
  app.get("/logs", getLogs);
  app.get("/logs/aggregate", getLogAggregates);
}