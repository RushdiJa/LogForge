import Fastify, { LogController, type FastifyInstance } from "fastify";

import type { QueryCache } from "./cache/redis-query-cache.js";
import type { Database } from "./db/client.js";
import { HealthController } from "./modules/health/health.controller.js";
import { HealthRepository } from "./modules/health/health.repository.js";
import { registerHealthRoutes } from "./modules/health/health.routes.js";
import { HealthService } from "./modules/health/health.service.js";
import { AggregateController } from "./modules/logs/aggregate/aggregate.controller.js";
import { AggregateRepository } from "./modules/logs/aggregate/aggregate.repository.js";
import { registerAggregateRoutes } from "./modules/logs/aggregate/aggregate.routes.js";
import { AggregateService } from "./modules/logs/aggregate/aggregate.service.js";
import { LogsController } from "./modules/logs/logs.controller.js";
import { LogsRepository } from "./modules/logs/logs.repository.js";
import { registerLogsRoutes } from "./modules/logs/logs.routes.js";
import { LogsService } from "./modules/logs/logs.service.js";
import type { DurableIngestionAcceptor, IngestionMetrics } from "./modules/logs/logs.type.js";
import { registerErrorHandler } from "./shared/error-handler.js";
import type { ReadinessState } from "./shared/readiness.js";

export interface AppDependencies {
  database: Database;
  ingestion: DurableIngestionAcceptor;
  ingestionMetrics?: IngestionMetrics;
  queryCache?: QueryCache;
  readiness: ReadinessState;
  logLevel?: string;
}

export function createApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: { level: dependencies.logLevel ?? "warn" },
    bodyLimit: 16 * 1_024 * 1_024,
    requestTimeout: 30_000,
    keepAliveTimeout: 72_000,
    connectionTimeout: 10_000,
    logController: new LogController({ disableRequestLogging: true }),
  });

  if (dependencies.ingestionMetrics !== undefined) {
    app.addHook("onRequest", (request, _reply, done) => {
      if (request.method === "POST" && request.url === "/logs") {
        dependencies.ingestionMetrics?.recordHttpRequestStarted(request);
      }
      done();
    });
    app.addHook("preValidation", (request, _reply, done) => {
      if (request.method === "POST" && request.url === "/logs") {
        dependencies.ingestionMetrics?.recordHttpBodyParsed(request);
      }
      done();
    });
    app.addHook("onResponse", (request, _reply, done) => {
      if (request.method === "POST" && request.url === "/logs") {
        dependencies.ingestionMetrics?.recordHttpRequestCompleted(request);
      }
      done();
    });
    app.addHook("onRequestAbort", (request, done) => {
      if (request.method === "POST" && request.url === "/logs") {
        dependencies.ingestionMetrics?.recordHttpRequestCompleted(request);
      }
      done();
    });
  }

  registerErrorHandler(app);

  const logsRepository = new LogsRepository(dependencies.database);
  const logsController = new LogsController(
    new LogsService(logsRepository, dependencies.ingestion, dependencies.ingestionMetrics),
  );
  const aggregateController = new AggregateController(
    new AggregateService(
      new AggregateRepository(dependencies.database),
      dependencies.queryCache,
    ),
  );
  const healthController = new HealthController(
    new HealthService(new HealthRepository(dependencies.database), dependencies.readiness),
  );

  registerHealthRoutes(app, healthController);
  registerAggregateRoutes(app, aggregateController);
  registerLogsRoutes(app, logsController);

  app.setNotFoundHandler(async (_request, reply) => {
    await reply.status(404).send({
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });

  return app;
}
