import type { FastifyReply, FastifyRequest } from "fastify";

import type { LogsService } from "./logs.service.js";

export class LogsController {
  constructor(private readonly service: LogsService) {}

  ingest = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const result = await this.service.ingest(request.body);
    const statusCode = result.accepted > 0 ? 200 : 400;
    await reply.status(statusCode).send(result);
  };

  query = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await reply.status(200).send(await this.service.query(request.query));
  };
}
