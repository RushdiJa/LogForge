import type {
  FastifyReply,
  FastifyRequest,
} from "fastify";

import { insertLogs } from "./repository.js";
import { validateLogs } from "./validate.js";

export async function postLogs(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const body = request.body;
  if (
    typeof body !== "object" ||
    body === null ||
    !("logs" in body) ||
    !Array.isArray(body.logs)
  ) {
    reply.code(400);
    return {
      error: "Invalid request body",
    };
  }
  const result = validateLogs(body.logs);

  if (result.valid.length === 0) {
    reply.code(400);

    return {
      accepted: 0,
      rejected: result.rejected,
    };
  }

  await insertLogs(result.valid);

  return {
    accepted: result.valid.length,
    rejected: result.rejected,
  };
}