import type { FastifyReply, FastifyRequest } from "fastify";

import type { HealthService } from "./health.service.js";

export class HealthController {
  constructor(private readonly service: HealthService) {}

  check = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await reply.status(200).send(await this.service.check());
  };
}
