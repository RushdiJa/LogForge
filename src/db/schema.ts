import { bigint, bigserial, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const logLevel = pgEnum("log_level", ["debug", "info", "warn", "error"]);

export const logs = pgTable(
  "logs",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    timestamp: timestamp("timestamp", { withTimezone: true, precision: 3 }).notNull(),
    level: logLevel("level").notNull(),
    service: text("service").notNull(),
    message: text("message").notNull(),
    attributes: jsonb("attributes").notNull().default({}),
    ingestedAt: timestamp("ingested_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("logs_timestamp_id_idx").on(table.timestamp.desc(), table.id.desc()),
    index("logs_service_level_timestamp_id_idx").on(
      table.service,
      table.level,
      table.timestamp.desc(),
      table.id.desc(),
    ),
  ],
);

export const logMessageSearch = pgTable(
  "log_message_search",
  {
    message: text("message").primaryKey(),
  },
  (table) => [
    index("log_message_search_trgm_idx").using(
      "gin",
      table.message.op("gin_trgm_ops"),
    ),
  ],
);

export const logLegacyMessageSearch = pgTable(
  "log_legacy_message_search",
  {
    message: text("message").primaryKey(),
  },
  (table) => [
    index("log_legacy_message_search_trgm_idx").using(
      "gin",
      table.message.op("gin_trgm_ops"),
    ),
  ],
);

export const logHotArchiveMessageSearch = pgTable(
  "log_hot_archive_message_search",
  {
    message: text("message").primaryKey(),
  },
  (table) => [
    index("log_hot_archive_message_search_trgm_idx").using(
      "gin",
      table.message.op("gin_trgm_ops"),
    ),
  ],
);

export const logRollups1m = pgTable(
  "log_rollups_1m",
  {
    bucketStart: timestamp("bucket_start", { withTimezone: true, precision: 0 }).notNull(),
    service: text("service").notNull(),
    level: logLevel("level").notNull(),
    count: bigint("count", { mode: "bigint" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.bucketStart, table.service, table.level] })],
);

export const ingestionBatches = pgTable(
  "ingestion_batches",
  {
    batchId: uuid("batch_id").primaryKey(),
    payload: jsonb("payload"),
    acceptedCount: integer("accepted_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    lastPublishAttemptAt: timestamp("last_publish_attempt_at", {
      withTimezone: true,
      precision: 3,
    }),
    publishAttempts: integer("publish_attempts").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true, precision: 3 }),
    processedAt: timestamp("processed_at", { withTimezone: true, precision: 3 }),
    lastPublishError: text("last_publish_error"),
  },
  (table) => [
    index("ingestion_batches_pending_publish_idx").on(
      table.lastPublishAttemptAt,
      table.createdAt,
      table.batchId,
    ),
    index("ingestion_batches_processed_at_idx").on(table.processedAt),
  ],
);
