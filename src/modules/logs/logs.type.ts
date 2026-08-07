import { z } from "zod";

// regex format
const ISO_8601_TIMESTAMP = 
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const timestampSchema = z
  .string()
  .regex(ISO_8601_TIMESTAMP, "Timestamp must be valid ISO 8601")
  .refine(
    (timestamp) => !Number.isNaN(Date.parse(timestamp)),
    "Timestamp is not a valid date",
  )
  .refine(
    (timestamp) =>
      Date.parse(timestamp) <= Date.now() + 5 * 60 * 1000,
    "Timestamp must not be more than five minutes in the future",
  )
  .transform((timestamp) => new Date(timestamp));

export const attributesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

export const logSchema = z.object({
  timestamp: timestampSchema,
  level: z.enum(["debug", "info", "warn", "error"]),
  service: z.string().min(1, "Service is required"),
  message: z.string().min(1, "Message is required"),
  attributes: attributesSchema.default({}),
}).strict();

export type LogInput = z.input<typeof logSchema>;

export type Log = z.output<typeof logSchema>;

export type Attributes = z.infer<typeof attributesSchema>;

export type RejectedLog = {
  index: number;
  reason: string;
};

export type ValidateLogsResult = {
    valid: Log[];
    rejected: RejectedLog[];
};

export type LogsErrorCode =
  | "INVALID_REQUEST_BODY"
  | "LOGS_DATABASE_ERROR"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INVALID_QUERY_PARAMETERS";

export class LogsError extends Error {
  public readonly code: LogsErrorCode;
  public readonly statusCode: number;
  constructor(
    code: LogsErrorCode,
    statusCode: number,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.name = "LogsError";
  }
}

// =

const queryTimestampSchema = z
  .string()
  .regex(
    ISO_8601_TIMESTAMP,
    "Timestamp must be valid ISO 8601",
  )
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "Timestamp is not a valid date",
  )
  .transform((value) => new Date(value));

const cursorPayloadSchema = z
  .object({
    timestamp: queryTimestampSchema,

    id: z
      .string()
      .regex(/^\d+$/, "Cursor id must be numeric")
      .transform(BigInt),
  })
  .strict();

const cursorSchema = z
  .string()
  .min(1, "Cursor must not be empty")
  .transform((value, ctx) => {
    try {
      const decoded = Buffer
        .from(value, "base64url")
        .toString("utf8");

      const payload = JSON.parse(decoded);

      const result = cursorPayloadSchema.safeParse(payload);

      if (!result.success) {
        ctx.addIssue({
          code: "custom",
          message: "Cursor is invalid or malformed",
        });

        return z.NEVER;
      }

      return result.data;
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Cursor is invalid or malformed",
      });

      return z.NEVER;
    }
  });

export const logsFiltersSchema = z
  .object({
    service: z.string().min(1).optional(),

    level: z
      .enum(["debug", "info", "warn", "error"])
      .optional(),

    since: queryTimestampSchema.optional(),

    until: queryTimestampSchema.optional(),

    q: z.string().optional(),

    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(100),

    cursor: cursorSchema.optional(),
  })
  .refine(
    (filters) =>
      !filters.since ||
      !filters.until ||
      filters.until > filters.since,
    {
      path: ["until"],
      message: "Until must be later than since",
    },
  );

export type LogsCursor = z.output<
  typeof cursorPayloadSchema
>;

export type LogsFilters = z.output<
  typeof logsFiltersSchema
>;

export type AttributeFilters =
  Record<string, string>;

export type ParsedLogsFilters =
  LogsFilters & {
    attributes: AttributeFilters;
};