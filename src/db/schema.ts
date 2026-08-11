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
      table.timestamp,
      table.id,
    ),

    index(
      "logs_service_idx",
    ).on(table.service),
  ],
);


/*
 * One-minute pre-aggregated log counts.
 *
 * One row represents:
 *
 * bucket_start + service + level
 */
export const logRollups1m =
  pgTable(
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

      service:
        text("service").notNull(),

      level:
        logLevelEnum(
          "level",
        ).notNull(),

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