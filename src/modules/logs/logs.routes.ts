import type { FastifyInstance } from "fastify";

import {
  createLogsController,
  getLogsAggregateController,
  getLogsController,
} from "./logs.controller.js";

import { logsErrorHandler } from "./logs.errors.js";

export async function logsRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.setErrorHandler(logsErrorHandler);

  app.post("/", createLogsController);

  app.get("/", getLogsController);

  app.get(
    "/aggregate",
    getLogsAggregateController,
  );
}