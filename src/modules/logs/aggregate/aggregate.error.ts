import { ApiError } from "../../../shared/api-error.js";

export class InvalidAggregateQueryError extends ApiError {
  constructor(message: string) {
    super(400, "INVALID_QUERY", message);
  }
}
