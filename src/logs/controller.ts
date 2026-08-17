import type {
  FastifyReply,
  FastifyRequest,
} from "fastify";

import { selectLogAggregates, selectLogs } from "./repository.js";
import { validateLogs, validateFilters, validateAggregateFilters } from "./validate.js";
import type { AggregateFilterResult, FilterResult } from "./type.js";
import { enqueueLogs } from "./batcher.js";

export async function postLogs(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const body = request.body;
  if (
    typeof body !== "object" ||
    body === null ||
    !("logs" in body) ||
    !Array.isArray(body.logs)
  ) {
    reply.code(400);
    return {
      error: "Invalid request body",
    };
  }
  
  const result = validateLogs(body.logs);

  if (result.valid.length === 0) {
    reply.code(400);

    return {
      accepted: 0,
      rejected: result.rejected,
    };
  }

  await enqueueLogs(result.valid);
  
  return {
    accepted: result.valid.length,
    rejected: result.rejected,
  };
}

export async function getLogs(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  let filters: FilterResult;

  try {
    filters = validateFilters(request.query);
  } catch (error) {
    return reply.code(400).send({
      error:
        error instanceof Error
          ? error.message
          : "Invalid query parameters",
    });
  }

  const logs = await selectLogs({
    ...filters,
    limit: filters.limit + 1,
  });

  const hasMore = logs.length > filters.limit;
  const resultLogs = logs.slice(0, filters.limit);
  const lastLog = resultLogs.at(-1);

  const nextCursor =
    hasMore && lastLog
      ? Buffer.from(String(lastLog.id)).toString("base64url")
      : null;

  return reply.code(200).send({
    logs: resultLogs,
    next_cursor: nextCursor,
  });
}

export async function getLogAggregates(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  let filters: AggregateFilterResult;

  try {
    filters = validateAggregateFilters(request.query);
  } catch (error) {
    return reply.code(400).send({
      error:
        error instanceof Error
          ? error.message
          : "Invalid aggregation filters",
    });
  }

  const buckets = await selectLogAggregates(filters);

  return reply.code(200).send({
    buckets,
  });
}