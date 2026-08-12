import { ApiError } from "../../shared/api-error.js";

export class ServiceNotReadyError extends ApiError {
  constructor() {
    super(503, "NOT_READY", "Service is not ready");
  }
}
