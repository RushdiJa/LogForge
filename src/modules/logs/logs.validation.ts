import {
  logSchema,
  LogsError,
  type RejectedLog,
  type Log,
  type ValidateLogsResult,
  logsFiltersSchema,
  type LogsFilters,
  type ParsedLogsFilters
} from "./logs.type.js";

export async function validLogs(logs: unknown): Promise<ValidateLogsResult> {
    if (!Array.isArray(logs)) {
        throw new LogsError(
            "INVALID_REQUEST_BODY", 
            400, 
            "logs must be an array"
        );
    }

    const valid: Log[] = [];
    const rejected : RejectedLog[] = []
    logs.forEach((log, index) => {
        const result = logSchema.safeParse(log);

        if (result.success) {
            valid.push(result.data);
        } else {
            rejected.push({
                index: index,
                reason: result.error.issues
                .map((issue) => {
                    const field = issue.path.join(".");

                    return field ? `${field}: ${issue.message}` : issue.message;
                })
                .join("\n"),
            });
        }
    });
    return {
        valid,
        rejected,
    };
}

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
