import type { FastifyInstance } from "fastify";

import type { HealthController } from "./health.controller.js";
import { HEALTH_ROUTE } from "./health.validate.js";

export function registerHealthRoutes(app: FastifyInstance, controller: HealthController): void {
  app.get(HEALTH_ROUTE, controller.check);
}
