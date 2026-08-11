import Fastify, {
  type FastifyInstance,
} from "fastify";

import { healthRoutes } from "./modules/health/health.routes.js";
import { logsRoutes } from "./modules/logs/logs.routes.js";

export function createApp(): FastifyInstance {
  const app = Fastify({
    logger: false,

    // Same as express.json({ limit: "1mb" })
    bodyLimit: 1024 * 1024,
  });

  app.register(healthRoutes, {
    prefix: "/health",
  });

  app.register(logsRoutes, {
    prefix: "/logs",
  });

  return app;
}