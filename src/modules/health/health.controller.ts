import type {
  FastifyRequest,
  FastifyReply,
} from "fastify";

import { checkHealth } from "./health.service.js";

export async function getHealth(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const health = await checkHealth();

  if (!health.ready) {
    reply
      .code(503)
      .send({
        status: "not_ready",
      });

    return;
  }

  reply
    .code(200)
    .send({
      status: "ok",
    });
}