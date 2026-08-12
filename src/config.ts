export interface AppConfig {
  port: number;
  databaseUrl: string;
  rabbitMqUrl: string;
  retentionDays: number;
  logLevel: string;
  queueFlushIntervalMs: number;
  queueMaxBatchLogs: number;
  queueMetricsIntervalMs: number;
  queueConsumerEnabled: boolean;
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);

  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

export function loadConfig(): AppConfig {
  return {
    port: integer("PORT", 8080, 1, 65_535),
    databaseUrl:
      process.env.DATABASE_URL ?? "postgres://logforge:logforge@localhost:5432/logforge",
    rabbitMqUrl: process.env.RABBITMQ_URL ?? "amqp://logforge:logforge@localhost:5672",
    retentionDays: integer("RETENTION_DAYS", 30, 1, 3_650),
    logLevel: process.env.LOG_LEVEL ?? "warn",
    queueFlushIntervalMs: integer("QUEUE_FLUSH_INTERVAL_MS", 250, 5, 1_000),
    queueMaxBatchLogs: integer("QUEUE_MAX_BATCH_LOGS", 5_000, 100, 20_000),
    queueMetricsIntervalMs: integer("QUEUE_METRICS_INTERVAL_MS", 0, 0, 60_000),
    queueConsumerEnabled: boolean("QUEUE_CONSUMER_ENABLED", true),
  };
}
