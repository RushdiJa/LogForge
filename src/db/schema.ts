import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  pgEnum
} from "drizzle-orm/pg-core";

type LogAttributeValue = string | number | boolean;
const logLevelEnum = pgEnum("log_level", [
  "debug",
  "info",
  "warn",
  "error",
]);

export const logs = pgTable(
  "logs",
  {
    id: bigint("id", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .primaryKey(),

    timestamp: timestamp("timestamp", {
      withTimezone: true,
      mode: "date",
      precision: 3,
    }).notNull(),

    level: logLevelEnum("level").notNull(),

    service: text("service").notNull(),

    message: text("message").notNull(),

    attributes: jsonb("attributes")
      .$type<Record<string, LogAttributeValue>>()
      .notNull()
      .default({}),

    ingestedAt: timestamp("ingested_at", {
      withTimezone: true,
      mode: "date",
      precision: 3,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("logs_timestamp_id_idx").on(table.timestamp, table.id),
    index("logs_service_idx").on(table.service),
    index("logs_level_idx").on(table.level),
  ],
);