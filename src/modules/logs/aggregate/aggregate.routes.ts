import type { FastifyInstance } from "fastify";

import type { AggregateController } from "./aggregate.controller.js";

export function registerAggregateRoutes(
  app: FastifyInstance,
  controller: AggregateController,
): void {
  app.get("/logs/aggregate", controller.aggregate);
}
