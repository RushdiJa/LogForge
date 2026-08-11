import type {
  FastifyReply,
  FastifyRequest,
} from "fastify";

import {
  getLogs,
  getLogsAggregate,
  insertLogs,
} from "./logs.service.js";

import type {
  ValidateLogsResult,
} from "./logs.type.js";

import {
  LogsError,
} from "./logs.type.js";


export async function createLogsController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const contentType =
    request.headers["content-type"];

  if (
    !contentType
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw new LogsError(
      "UNSUPPORTED_MEDIA_TYPE",
      415,
      "Content-Type must be application/json",
    );
  }

  const body = request.body as {
    logs?: unknown;
  };

  const result: ValidateLogsResult =
    await insertLogs(body?.logs);

  const accepted =
    result.valid.length;

  if (accepted === 0) {
    reply
      .code(400)
      .send({
        accepted: 0,
        rejected:
          result.rejected,
      });

    return;
  }

  reply
    .code(200)
    .send({
      accepted,
      rejected:
        result.rejected,
    });
}
export async function getLogsController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const result = await getLogs(
    request.query,
  );

  reply
    .code(200)
    .send(result);
}


export async function getLogsAggregateController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const result =
    await getLogsAggregate(
      request.query,
    );

  reply
    .code(200)
    .send(result);
}