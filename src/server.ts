import { createApp } from "./app.js";
import { RedisQueryCache } from "./cache/redis-query-cache.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { applyMigrations } from "./db/migrate.js";
import { LogsRepository } from "./modules/logs/logs.repository.js";
import { OutboxRepository } from "./modules/queue/outbox.repository.js";
import { OutboxService } from "./modules/queue/outbox.service.js";
import { QueuePublisher } from "./modules/queue/queue.publisher.js";
import { QueueMetrics, QueueMetricsReporter } from "./modules/queue/queue.metrics.js";
import { QueueRepository } from "./modules/queue/queue.repository.js";
import { QueueConsumerService } from "./modules/queue/queue.service.js";
import { QueueSupervisor } from "./modules/queue/queue.supervisor.js";
import { RetentionRepository } from "./modules/retention/retention.repository.js";
import { RetentionService } from "./modules/retention/retention.service.js";
import { ReadinessState } from "./shared/readiness.js";

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
const readiness = new ReadinessState();
const queueRepository = new QueueRepository();
const queueMetrics =
  config.queueMetricsIntervalMs === 0 ? undefined : new QueueMetrics();
const publisher = new QueuePublisher(queueRepository, queueMetrics);
const outbox = new OutboxService(new OutboxRepository(database), publisher);
const queryCache = new RedisQueryCache(config.redisUrl, config.cacheTtlMs);
const app = createApp({
  database,
  ingestion: outbox,
  queryCache,
  ...(queueMetrics === undefined ? {} : { ingestionMetrics: queueMetrics }),
  readiness,
  logLevel: config.logLevel,
});
outbox.setLogger(app.log);
const queueConsumer = new QueueConsumerService(
  queueRepository,
  new LogsRepository(database),
  app.log,
  {
    flushIntervalMs: config.queueFlushIntervalMs,
    maxBatchLogs: config.queueMaxBatchLogs,
    writeConcurrency: config.queueWriteConcurrency,
  },
  queueMetrics,
);
const queueSupervisor = new QueueSupervisor(
  config.rabbitMqUrl,
  queueRepository,
  queueConsumer,
  outbox,
  app.log,
);
const queueMetricsReporter =
  queueMetrics === undefined
    ? undefined
    : new QueueMetricsReporter(
        queueRepository,
        queueMetrics,
        app.log,
        config.queueMetricsIntervalMs,
      );
const retention = new RetentionService(
  new RetentionRepository(database),
  config.retentionDays,
  app.log,
);
let cacheMetricsTimer: NodeJS.Timeout | undefined;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  readiness.markNotReady();
  app.log.info({ signal }, "Shutting down");

  retention.stop();
  queueMetricsReporter?.stop();
  if (cacheMetricsTimer !== undefined) clearInterval(cacheMetricsTimer);
  await app.close().catch(() => undefined);
  await outbox.stop().catch(() => undefined);
  await queueSupervisor.stop().catch(() => undefined);
  await queryCache.stop().catch(() => undefined);
  await database.end({ timeout: 5 }).catch(() => undefined);
}

async function start(): Promise<void> {
  await database`SELECT 1`;
  await applyMigrations(database);
  queryCache.start();
  await app.listen({ host: "0.0.0.0", port: config.port });
  retention.start();
  outbox.start();
  if (config.queueConsumerEnabled) {
    queueSupervisor.start();
  } else {
    app.log.warn("Queue pipeline disabled for controlled diagnostics");
  }
  queueMetricsReporter?.start();
  if (config.queueMetricsIntervalMs > 0) {
    cacheMetricsTimer = setInterval(() => {
      app.log.info({ cacheMetrics: queryCache.snapshot() }, "Query cache metrics");
    }, config.queueMetricsIntervalMs);
    cacheMetricsTimer.unref();
  }
  readiness.markReady();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

start().catch(async (error: unknown) => {
  app.log.fatal(error, "Failed to start service");
  await shutdown("startup-error");
  process.exit(1);
});
  
