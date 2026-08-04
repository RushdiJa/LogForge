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
});

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
  ;
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