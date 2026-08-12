import type { FastifyInstance } from "fastify";

import type { LogsController } from "./logs.controller.js";

export function registerLogsRoutes(app: FastifyInstance, controller: LogsController): void {
  app.post("/logs", controller.ingest);
  app.get("/logs", controller.query);
}
