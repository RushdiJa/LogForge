import { ApiError } from "../../shared/api-error.js";

export class InvalidLogsRequestError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(400, "INVALID_REQUEST", message, details);
  }
}

export class InvalidLogsQueryError extends ApiError {
  constructor(message: string) {
    super(400, "INVALID_QUERY", message);
  }
}

export class QueueUnavailableError extends ApiError {
  constructor() {
    super(503, "QUEUE_UNAVAILABLE", "Log ingestion is temporarily unavailable");
  }
}
