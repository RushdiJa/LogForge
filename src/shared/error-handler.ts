import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ApiError } from "./api-error.js";

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: FastifyError | ApiError, _request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof ApiError) {
        const body: ErrorBody = {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        };
        return reply.status(error.statusCode).send(body);
      }

      if (error.code === "FST_ERR_CTP_INVALID_JSON_BODY") {
        return reply.status(400).send({
          error: { code: "INVALID_JSON", message: "Request body contains malformed JSON" },
        });
      }

      if (error.validation !== undefined) {
        return reply.status(400).send({
          error: { code: "INVALID_REQUEST", message: "Invalid request" },
        });
      }

      if (
        error.statusCode !== undefined &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      ) {
        return reply.status(error.statusCode).send({
          error: { code: "INVALID_REQUEST", message: "Invalid request" },
        });
      }

      app.log.error(error);
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
      });
    },
  );
}
