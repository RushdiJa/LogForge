import { bigint, bigserial, index, jsonb, pgEnum, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

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
    index("logs_level_timestamp_id_idx").on(table.level, table.timestamp.desc(), table.id.desc()),
    index("logs_message_trgm_idx").using("gin", table.message.op("gin_trgm_ops")),
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
