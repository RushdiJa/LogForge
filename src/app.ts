import Fastify, { type FastifyInstance } from "fastify";

import { health } from "./health.js";
import {logsRoute} from "./logs/route.js"

export function createApp(): FastifyInstance {
  const app = Fastify();
  app.register(health);
  app.register(logsRoute);
  return app;
}