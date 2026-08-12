import { InvalidLogsQueryError } from "../logs.error.js";
import { validateLogQuery } from "../logs.validate.js";
import { InvalidAggregateQueryError } from "./aggregate.error.js";
import {
  BUCKETS,
  GROUPS,
  type AggregateQuery,
  type Bucket,
  type GroupBy,
} from "./aggregate.type.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateAggregateQuery(raw: unknown): AggregateQuery {
  if (!isRecord(raw)) {
    throw new InvalidAggregateQueryError("query parameters are invalid");
  }

  for (const key of Object.keys(raw)) {
    if (
      key !== "service" &&
      key !== "level" &&
      key !== "since" &&
      key !== "until" &&
      key !== "q" &&
      key !== "bucket" &&
      key !== "group_by" &&
      !key.startsWith("attr.")
    ) {
      throw new InvalidAggregateQueryError(`unknown query parameter: ${key}`);
    }
  }

  if (typeof raw.since !== "string" || typeof raw.until !== "string") {
    throw new InvalidAggregateQueryError("since and until are required");
  }
  if (typeof raw.bucket !== "string" || !(BUCKETS as readonly string[]).includes(raw.bucket)) {
    throw new InvalidAggregateQueryError("bucket must be one of: 1m, 5m, 1h, 1d");
  }
  if (
    raw.group_by !== undefined &&
    (typeof raw.group_by !== "string" || !(GROUPS as readonly string[]).includes(raw.group_by))
  ) {
    throw new InvalidAggregateQueryError("group_by must be service or level");
  }

  try {
    const commonQuery: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key !== "bucket" && key !== "group_by") {
        commonQuery[key] = value;
      }
    }
    const filters = validateLogQuery(commonQuery);

    return {
      ...(filters.service === undefined ? {} : { service: filters.service }),
      ...(filters.level === undefined ? {} : { level: filters.level }),
      since: filters.since as string,
      until: filters.until as string,
      attributes: filters.attributes,
      ...(filters.q === undefined ? {} : { q: filters.q }),
      bucket: raw.bucket as Bucket,
      ...(raw.group_by === undefined ? {} : { groupBy: raw.group_by as GroupBy }),
    };
  } catch (error) {
    if (error instanceof InvalidLogsQueryError) {
      throw new InvalidAggregateQueryError(error.message);
    }
    throw error;
  }
}
