import type {
  FastifyError,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import { LogsError } from "./logs.type.js";

export function logsErrorHandler(
  error: FastifyError | Error,
  _request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof LogsError) {
    reply
      .code(error.statusCode)
      .send({
        error: error.message,
      });

    return;
  }

  if (
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    error.statusCode < 500
  ) {
    reply
      .code(error.statusCode)
      .send({
        error: error.message,
      });

    return;
  }

  console.error(
    "Unexpected logs error:",
    error,
  );

  reply
    .code(500)
    .send({
      error:
        "An unexpected error occurred",
    });
}