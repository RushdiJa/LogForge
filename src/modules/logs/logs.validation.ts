import {
  LogsError,
  type RejectedLog,
  type Log,
  type ValidateLogsResult,
  type ParsedLogsFilters,
  type ParsedAggregateFilters,
  type Attributes,
  type LogLevel,
  type LogsCursor,
  type AggregateBucket,
  type AggregateGroupBy,
} from "./logs.type.js";

const ISO_8601_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const FIVE_MINUTES_MS =
  5 * 60 * 1000;

/*
 * ============================================================
 * COMMON HELPERS
 * ============================================================
 */

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isLogLevel(
  value: unknown,
): value is LogLevel {
  return (
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error"
  );
}

function isAggregateBucket(
  value: unknown,
): value is AggregateBucket {
  return (
    value === "1m" ||
    value === "5m" ||
    value === "1h" ||
    value === "1d"
  );
}

function isAggregateGroupBy(
  value: unknown,
): value is AggregateGroupBy {
  return (
    value === "service" ||
    value === "level"
  );
}

function parseQueryTimestamp(
  value: unknown,
  field: string,
): Date {
  if (
    typeof value !== "string" ||
    !ISO_8601_TIMESTAMP.test(value)
  ) {
    throw new LogsError(
      "INVALID_QUERY_PARAMETERS",
      400,
      `${field}: Timestamp must be valid ISO 8601`,
    );
  }

  const timestampMs =
    Date.parse(value);

  if (Number.isNaN(timestampMs)) {
    throw new LogsError(
      "INVALID_QUERY_PARAMETERS",
      400,
      `${field}: Timestamp is not a valid date`,
    );
  }

  return new Date(timestampMs);
}

/*
 * ============================================================
 * CURSOR
 * ============================================================
 */

function parseCursor(
  value: unknown,
): LogsCursor {
  if (
    typeof value !== "string" ||
    value.length === 0
  ) {
    throw new LogsError(
      "INVALID_QUERY_PARAMETERS",
      400,
      "Cursor must not be empty",
    );
  }

  try {
    const decoded =
      Buffer
        .from(
          value,
          "base64url",
        )
        .toString("utf8");

    const payload: unknown =
      JSON.parse(decoded);

    if (!isRecord(payload)) {
      throw new Error();
    }

    /*
     * cursorPayloadSchema كان .strict()
     *
     * يعني timestamp + id فقط.
     */
    const keys =
      Object.keys(payload);

    if (
      keys.length !== 2 ||
      !("timestamp" in payload) ||
      !("id" in payload)
    ) {
      throw new Error();
    }

    const timestamp =
      parseQueryTimestamp(
        payload.timestamp,
        "timestamp",
      );

    if (
      typeof payload.id !== "string" ||
      !/^\d+$/.test(payload.id)
    ) {
      throw new Error();
    }

    return {
      timestamp,
      id: Number(payload.id),
    };
  } catch {
    throw new LogsError(
      "INVALID_QUERY_PARAMETERS",
      400,
      "Cursor is invalid or malformed",
    );
  }
}

/*
 * ============================================================
 * ATTRIBUTE QUERY FILTERS
 * ============================================================
 */

function parseAttributeFilters(
  query: Record<string, unknown>,
): Record<string, string> {
  const attributes:
    Record<string, string> = {};

  /*
   * for...in avoids Object.entries()
   * allocation on this path.
   */
  for (const key in query) {
    if (
      !key.startsWith("attr.")
    ) {
      continue;
    }

    const attributeKey =
      key.slice("attr.".length);

    if (
      attributeKey.length === 0
    ) {
      throw new LogsError(
        "INVALID_QUERY_PARAMETERS",
        400,
        "Attribute key must not be empty",
      );
    }

    const value =
      query[key];

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

    attributes[attributeKey] =
      String(value);
  }

  return attributes;
}

/*
 * ============================================================
 * POST /logs
 * ============================================================
 */

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

  /*
   * نحسبها مرة واحدة للـbatch كامل.
   */
  const maxTimestamp =
    Date.now() +
    FIVE_MINUTES_MS;

  for (
    let index = 0;
    index < logs.length;
    index++
  ) {
    const value =
      logs[index];

    if (!isRecord(value)) {
      rejected.push({
        index,
        reason:
          "log must be an object",
      });

      continue;
    }

    /*
     * logSchema القديم كان .strict()
     *
     * لذلك أي field غير معروف لازم
     * يرفض الـlog.
     */
    let unknownField:
      string | undefined;

    for (const key in value) {
      if (
        key !== "timestamp" &&
        key !== "level" &&
        key !== "service" &&
        key !== "message" &&
        key !== "attributes"
      ) {
        unknownField = key;
        break;
      }
    }

    if (
      unknownField !== undefined
    ) {
      rejected.push({
        index,
        reason:
          `Unrecognized field: ${unknownField}`,
      });

      continue;
    }

    /*
     * =========================
     * TIMESTAMP
     * =========================
     */

    const timestamp =
      value.timestamp;

    if (
      typeof timestamp !== "string" ||
      !ISO_8601_TIMESTAMP.test(
        timestamp,
      )
    ) {
      rejected.push({
        index,
        reason:
          "timestamp: invalid ISO 8601 timestamp",
      });

      continue;
    }

    const timestampMs =
      Date.parse(timestamp);

    if (
      Number.isNaN(timestampMs)
    ) {
      rejected.push({
        index,
        reason:
          "timestamp: invalid ISO 8601 timestamp",
      });

      continue;
    }

    if (
      timestampMs >
      maxTimestamp
    ) {
      rejected.push({
        index,
        reason:
          "timestamp: cannot be more than 5 minutes in the future",
      });

      continue;
    }

    /*
     * =========================
     * LEVEL
     * =========================
     */

    const level =
      value.level;

    if (
      !isLogLevel(level)
    ) {
      rejected.push({
        index,
        reason:
          "level: must be one of debug, info, warn, error",
      });

      continue;
    }

    /*
     * =========================
     * SERVICE
     * =========================
     */

    const service =
      value.service;

    if (
      typeof service !==
        "string" ||
      service.length === 0
    ) {
      rejected.push({
        index,
        reason:
          "service: must be a non-empty string",
      });

      continue;
    }

    /*
     * =========================
     * MESSAGE
     * =========================
     */

    const message =
      value.message;

    if (
      typeof message !==
        "string" ||
      message.length === 0
    ) {
      rejected.push({
        index,
        reason:
          "message: must be a non-empty string",
      });

      continue;
    }

    /*
     * =========================
     * ATTRIBUTES
     * =========================
     */

    const attributes =
      value.attributes;

    if (
      attributes !== undefined
    ) {
      if (!isRecord(attributes)) {
        rejected.push({
          index,
          reason:
            "attributes: must be a flat object",
        });

        continue;
      }

      let invalidAttribute:
        string | undefined;

      for (
        const key in attributes
      ) {
        const attributeValue =
          attributes[key];

        if (
          typeof attributeValue !==
            "string" &&
          typeof attributeValue !==
            "number" &&
          typeof attributeValue !==
            "boolean"
        ) {
          invalidAttribute =
            key;

          break;
        }
      }

      if (
        invalidAttribute !==
        undefined
      ) {
        rejected.push({
          index,
          reason:
            `attributes.${invalidAttribute}: must be a string, number, or boolean`,
        });

        continue;
      }
    }

    /*
     * Same transformation the
     * old Zod schema performed:
     *
     * timestamp string -> Date
     * missing attributes -> {}
     */

    valid.push({
      timestamp:
        new Date(timestampMs),

      level,

      service,

      message,

      attributes:
        (attributes ?? {}) as Attributes,
    });
  }

  return {
    valid,
    rejected,
  };
}

/*
 * ============================================================
 * GET /logs
 * ============================================================
 */

export function validateLogsFilters(
  input: unknown,
): ParsedLogsFilters {
  if (!isRecord(input)) {
    throw new LogsError(
      "INVALID_QUERY_PARAMETERS",
      400,
      "Invalid query parameters",
    );
  }

  const query = input;

  /*
   * =========================
   * SERVICE
   * =========================
   */

  let service:
    string | undefined;

  if (
    query.service !== undefined
  ) {
    if (
      typeof query.service !==
        "string" ||
      query.service.length === 0
    ) {
      throw new LogsError(
        "INVALID_QUERY_PARAMETERS",
        400,
        "service: must be a non-empty string",
      );
    }

    service =
      query.service;
  }

  /*
   * =========================
   * LEVEL
   * =========================
   */

  let level:
    LogLevel | undefined;

  if (
    query.level !== undefined
  ) {
    if (
      !isLogLevel(query.level)
    ) {
      throw new LogsError(
        "INVALID_QUERY_PARAMETERS",
        400,
        "level: must be one of debug, info, warn, error",
      );
    }

    level =
      query.level;
  }

  /*
   * =========================
   * SINCE
   * =========================
   */

  let since:
    Date | undefined;

  if (
    query.since !== undefined
  ) {
    since =
      parseQueryTimestamp(
        query.since,
        "since",
      );
  }

  /*
   * =========================
   * UNTIL
   * =========================
   */

  let until:
    Date | undefined;

  if (
    query.until !== undefined
  ) {
    until =
      parseQueryTimestamp(
        query.until,
        "until",
      );
  }

  /*
   * Same behavior as:
   *
   * filters.until > filters.since
   */

  if (
    since !== undefined &&
    until !== undefined &&
    until <= since
  ) {
    throw new LogsError(
      "INVALID_QUERY_PARAMETERS",
      400,
      "until: Until must be later than since",
    );
  }

  /*
   * =========================
   * Q
   * =========================
   */

  let q:
    string | undefined;

  if (
    query.q !== undefined
  ) {
    if (
      typeof query.q !==
      "string"
    ) {
      throw new LogsError(
        "INVALID_QUERY_PARAMETERS",
        400,
        "q: must be a string",
      );
    }

    q =
      query.q;
  }

  /*
   * =========================
   * LIMIT
   * =========================
   *
   * Zod previously used:
   *
   * z.coerce.number()
   */

  let limit = 100;

  if (
    query.limit !== undefined
  ) {
    const parsedLimit =
      Number(query.limit);

    if (
      !Number.isInteger(
        parsedLimit,
      ) ||
      parsedLimit < 1 ||
      parsedLimit > 1000
    ) {
      throw new LogsError(
        "INVALID_QUERY_PARAMETERS",
        400,
        "limit: must be an integer between 1 and 1000",
      );
    }

    limit =
      parsedLimit;
  }

  /*
   * =========================
   * CURSOR
   * =========================
   */

  let cursor:
    LogsCursor | undefined;

  if (
    query.cursor !== undefined
  ) {
    cursor =
      parseCursor(
        query.cursor,
      );
  }

  /*
   * =========================
   * ATTRIBUTES
   * =========================
   */

  const attributes =
    parseAttributeFilters(
      query,
    );

  return {
    service,
    level,
    since,
    until,
    q,
    limit,
    cursor,
    attributes,
  };
}

/*
 * ============================================================
 * GET /logs/aggregate
 * ============================================================
 */

export function AggregateFilters(
  input: unknown,
): ParsedAggregateFilters {
  if (!isRecord(input)) {
    throw new LogsError(
      "INVALID_QUERY_PARAMETERS",
      400,
      "Invalid query parameters",
    );
  }

  const query = input;

  /*
   * =========================
   * SINCE
   * required
   * =========================
   */

  const since =
    parseQueryTimestamp(
      query.since,
      "since",
    );

  /*
   * =========================
   * UNTIL
   * required
   * =========================
   */

  const until =
    parseQueryTimestamp(
      query.until,
      "until",
    );

  if (until <= since) {
    throw new LogsError(
      "INVALID_QUERY_PARAMETERS",
      400,
      "until: Until must be later than since",
    );
  }

  /*
   * =========================
   * BUCKET
   * =========================
   */

  if (
    !isAggregateBucket(
      query.bucket,
    )
  ) {
    throw new LogsError(
      "INVALID_QUERY_PARAMETERS",
      400,
      "bucket: must be one of 1m, 5m, 1h, 1d",
    );
  }

  const bucket =
    query.bucket;

  /*
   * =========================
   * SERVICE
   * =========================
   */

  let service:
    string | undefined;

  if (
    query.service !== undefined
  ) {
    if (
      typeof query.service !==
        "string" ||
      query.service.length === 0
    ) {
      throw new LogsError(
        "INVALID_QUERY_PARAMETERS",
        400,
        "service: must be a non-empty string",
      );
    }

    service =
      query.service;
  }

  /*
   * =========================
   * LEVEL
   * =========================
   */

  let level:
    LogLevel | undefined;

  if (
    query.level !== undefined
  ) {
    if (
      !isLogLevel(query.level)
    ) {
      throw new LogsError(
        "INVALID_QUERY_PARAMETERS",
        400,
        "level: must be one of debug, info, warn, error",
      );
    }

    level =
      query.level;
  }

  /*
   * =========================
   * GROUP BY
   * =========================
   */

  let group_by:
    AggregateGroupBy | undefined;

  if (
    query.group_by !==
    undefined
  ) {
    if (
      !isAggregateGroupBy(
        query.group_by,
      )
    ) {
      throw new LogsError(
        "INVALID_QUERY_PARAMETERS",
        400,
        "group_by: must be service or level",
      );
    }

    group_by =
      query.group_by;
  }

  /*
   * =========================
   * Q
   * =========================
   */

  let q:
    string | undefined;

  if (
    query.q !== undefined
  ) {
    if (
      typeof query.q !==
        "string"
    ) {
      throw new LogsError(
        "INVALID_QUERY_PARAMETERS",
        400,
        "q: must be a string",
      );
    }

    q =
      query.q;
  }

  /*
   * =========================
   * ATTRIBUTES
   * =========================
   */

  const attributes =
    parseAttributeFilters(
      query,
    );

  return {
    service,
    level,
    since,
    until,
    bucket,
    group_by,
    q,
    attributes,
  };
}