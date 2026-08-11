import type { FastifyInstance } from "fastify";
import { getHealth } from "./health.controller.js";

export async function healthRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/", getHealth);
}