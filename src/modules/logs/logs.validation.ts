import {
  logSchema,
  LogsError,
  type RejectedLog,
  type Log,
  type ValidateLogsResult,
  logsFiltersSchema,
  type ParsedLogsFilters,
  type ParsedAggregateFilters,
  aggregateFiltersSchema,
  type Attributes
} from "./logs.type.js";

const ISO_8601_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const FIVE_MINUTES_MS = 5 * 60 * 1000;

export function validLogs(
  logs: unknown,
): ValidateLogsResult {
  if (!Array.isArray(logs)) {
    throw new LogsError(
      "INVALID_REQUEST_BODY",
      400,
      "logs must be an array",
    );
  }

  const valid: Log[] = [];
  const rejected: RejectedLog[] = [];

  const maxTimestamp = Date.now() + FIVE_MINUTES_MS;

  for (let index = 0; index < logs.length; index++) {
    const value = logs[index];

    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      rejected.push({
        index,
        reason: "log must be an object",
      });
      continue;
    }

    const log = value as Record<string, unknown>;

    // timestamp
    const timestamp = log.timestamp;

    if (
      typeof timestamp !== "string" ||
      !ISO_8601_TIMESTAMP.test(timestamp)
    ) {
      rejected.push({
        index,
        reason: "timestamp: invalid ISO 8601 timestamp",
      });
      continue;
    }

    const timestampMs = Date.parse(timestamp);

    if (Number.isNaN(timestampMs)) {
      rejected.push({
        index,
        reason: "timestamp: invalid ISO 8601 timestamp",
      });
      continue;
    }

    if (timestampMs > maxTimestamp) {
      rejected.push({
        index,
        reason:
          "timestamp: cannot be more than 5 minutes in the future",
      });
      continue;
    }

    // level
    const level = log.level;

    if (
      level !== "debug" &&
      level !== "info" &&
      level !== "warn" &&
      level !== "error"
    ) {
      rejected.push({
        index,
        reason:
          "level: must be one of debug, info, warn, error",
      });
      continue;
    }

    // service
    const service = log.service;

    if (
      typeof service !== "string" ||
      service.length === 0
    ) {
      rejected.push({
        index,
        reason: "service: must be a non-empty string",
      });
      continue;
    }

    // message
    const message = log.message;

    if (
      typeof message !== "string" ||
      message.length === 0
    ) {
      rejected.push({
        index,
        reason: "message: must be a non-empty string",
      });
      continue;
    }

    // attributes
    const attributes = log.attributes;

    if (attributes !== undefined) {
      if (
        typeof attributes !== "object" ||
        attributes === null ||
        Array.isArray(attributes)
      ) {
        rejected.push({
          index,
          reason: "attributes: must be a flat object",
        });
        continue;
      }

      let invalidAttribute = false;

      for (const key in attributes) {
        const attributeValue = (
          attributes as Record<string, unknown>
        )[key];

        const type = typeof attributeValue;

        if (
          type !== "string" &&
          type !== "number" &&
          type !== "boolean"
        ) {
          rejected.push({
            index,
            reason:
              `attributes.${key}: must be a string, number, or boolean`,
          });

          invalidAttribute = true;
          break;
        }
      }

      if (invalidAttribute) {
        continue;
      }
    }

    valid.push({
      timestamp: new Date(timestampMs),
      level,
      service,
      message,
      attributes:
        (attributes ?? {}) as Attributes,    });
    }

  return {
    valid,
    rejected,
  };
}
// export async function validLogs(logs: unknown): Promise<ValidateLogsResult> {
//     if (!Array.isArray(logs)) {
//         throw new LogsError(
//             "INVALID_REQUEST_BODY", 
//             400, 
//             "logs must be an array"
//         );
//     }

//     const valid: Log[] = [];
//     const rejected : RejectedLog[] = []
//     logs.forEach((log, index) => {
//         const result = logSchema.safeParse(log);

//         if (result.success) {
//             valid.push(result.data);
//         } else {
//             rejected.push({
//                 index: index,
//                 reason: result.error.issues
//                 .map((issue) => {
//                     const field = issue.path.join(".");

//                     return field ? `${field}: ${issue.message}` : issue.message;
//                 })
//                 .join("\n"),
//             });
//         }
//     });
//     return {
//         valid,
//         rejected,
//     };
// }
// export function validLogs(
//   logs: unknown,
// ): ValidateLogsResult {
//   if (!Array.isArray(logs)) {
//     throw new LogsError(
//       "INVALID_REQUEST_BODY",
//       400,
//       "logs must be an array",
//     );
//   }

//   const valid: Log[] = logs.map((log) => {
//     const value =
//       log as Record<string, unknown>;

//     return {
//       ...value,

//       timestamp: new Date(
//         value.timestamp as string,
//       ),
//     } as Log;
//   });

//   return {
//     valid,
//     rejected: [],
//   };
// }

export function validateLogsFilters(
  input: unknown,
): ParsedLogsFilters {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new LogsError(
      "INVALID_QUERY_PARAMETERS",
      400,
      "Invalid query parameters",
    );
  }
  const result = logsFiltersSchema.safeParse(input);

  if (!result.success) {
    const message = result.error.issues
      .map((issue) => {
        const field = issue.path.join(".");

        return field
          ? `${field}: ${issue.message}`
          : issue.message;
      })
      .join(", ");

    throw new LogsError(
      "INVALID_QUERY_PARAMETERS",
      400,
      message,
    );
  }

  

  const query = input as Record<string, unknown>;

  const attributes: Record<string, string> = {};

  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith("attr.")) {
      continue;
    }

    const attributeKey = key.slice("attr.".length);

    if (attributeKey.length === 0) {
      throw new LogsError(
        "INVALID_QUERY_PARAMETERS",
        400,
        "Attribute key must not be empty",
      );
    }

    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new LogsError(
        "INVALID_QUERY_PARAMETERS",
        400,
        `Attribute '${attributeKey}' must be a string, number, or boolean`,
      );
    }

    attributes[attributeKey] = String(value);
  }

  return {
    ...result.data,
    attributes,
  };
}

export function AggregateFilters(input: unknown) : ParsedAggregateFilters{
    if (
        typeof input !== "object" ||
        input === null ||
        Array.isArray(input)
    ) {
        throw new LogsError(
            "INVALID_QUERY_PARAMETERS",
            400,
            "Invalid query parameters",
        );
    }
    const result = aggregateFiltersSchema.safeParse(input);
    if (!result.success) {
        const message = result.error.issues
        .map((issue) => {
        const field = issue.path.join(".");

        return field
            ? `${field}: ${issue.message}`
            : issue.message;
        })
        .join(", ");

        throw new LogsError(
            "INVALID_QUERY_PARAMETERS",
            400,
            message,
        );
    }
    const query = input as Record<string, unknown>;

    const attributes: Record<string, string> = {};

    for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith("attr.")) {
        continue;
    }

    const attributeKey = key.slice("attr.".length);

    if (attributeKey.length === 0) {
        throw new LogsError(
        "INVALID_QUERY_PARAMETERS",
        400,
        "Attribute key must not be empty",
        );
    }

    if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
    ) {
        throw new LogsError(
        "INVALID_QUERY_PARAMETERS",
        400,
        `Attribute '${attributeKey}' must be a string, number, or boolean`,
        );
    }

        attributes[attributeKey] = String(value);
    }

    return {
        ...result.data,
        attributes,
    };
}