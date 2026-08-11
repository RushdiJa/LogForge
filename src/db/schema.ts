import {
  bigint,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";

type LogAttributeValue =
  | string
  | number
  | boolean;

export const logLevelEnum =
  pgEnum("log_level", [
    "debug",
    "info",
    "warn",
    "error",
  ]);

export const logs = pgTable(
  "logs",
  {
    id: bigint("id", {
      mode: "number",
    })
      .generatedAlwaysAsIdentity()
      .primaryKey(),

    timestamp: timestamp("timestamp", {
      withTimezone: true,
      mode: "date",
      precision: 3,
    }).notNull(),

    level:
      logLevelEnum("level").notNull(),

    service:
      text("service").notNull(),

    message:
      text("message").notNull(),

    attributes: jsonb("attributes")
      .$type<
        Record<
          string,
          LogAttributeValue
        >
      >()
      .notNull()
      .default({}),

    ingestedAt: timestamp(
      "ingested_at",
      {
        withTimezone: true,
        mode: "date",
        precision: 3,
      },
    )
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index(
      "logs_timestamp_id_idx",
    ).on(
      table.timestamp.desc(),
      table.id.desc(),
    ),

    index(
      "logs_service_level_timestamp_id_idx",
    ).on(
      table.service,
      table.level,
      table.timestamp.desc(),
      table.id.desc(),
    ),
  ],
);

/*
 * Counts are maintained by the same SQL statement that inserts
 * raw logs. Aggregations without message/attribute filters can
 * therefore read a few rollup rows instead of scanning the full
 * logs table while ingestion is active.
 */
export const logRollups1m = pgTable(
  "log_rollups_1m",
  {
    bucketStart: timestamp(
      "bucket_start",
      {
        withTimezone: true,
        mode: "date",
        precision: 3,
      },
    ).notNull(),

    service: text("service")
      .notNull(),

    level: logLevelEnum("level")
      .notNull(),

    count: bigint("count", {
      mode: "number",
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.bucketStart,
        table.service,
        table.level,
      ],
    }),
  ],
);

/*
 * Second rollups make arbitrary since/until boundaries cheap even while
 * hundreds of thousands of logs are arriving in the current minute.
 */
export const logRollups1s = pgTable(
  "log_rollups_1s",
  {
    bucketStart: timestamp(
      "bucket_start",
      {
        withTimezone: true,
        mode: "date",
        precision: 3,
      },
    ).notNull(),

    service: text("service")
      .notNull(),

    level: logLevelEnum("level")
      .notNull(),

    count: bigint("count", {
      mode: "number",
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.bucketStart,
        table.service,
        table.level,
      ],
    }),
  ],
);

/*
 * Hour rollups keep long-range 1h/1d aggregations small. The benchmark's
 * 28-day primary query reads thousands of rows instead of minute-level data.
 */
export const logRollups1h = pgTable(
  "log_rollups_1h",
  {
    bucketStart: timestamp(
      "bucket_start",
      {
        withTimezone: true,
        mode: "date",
        precision: 3,
      },
    ).notNull(),

    service: text("service")
      .notNull(),

    level: logLevelEnum("level")
      .notNull(),

    count: bigint("count", {
      mode: "number",
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.bucketStart,
        table.service,
        table.level,
      ],
    }),
  ],
);
