import type { FastifyReply, FastifyRequest } from "fastify";

import type { AggregateService } from "./aggregate.service.js";

export class AggregateController {
  constructor(private readonly service: AggregateService) {}

  aggregate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await reply.status(200).send(await this.service.aggregate(request.query));
  };
}
