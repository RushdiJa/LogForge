import type { ReadinessState } from "../../shared/readiness.js";
import { ServiceNotReadyError } from "./health.error.js";
import type { HealthRepository } from "./health.repository.js";
import type { HealthResponse } from "./health.type.js";

export class HealthService {
  constructor(
    private readonly repository: HealthRepository,
    private readonly readiness: ReadinessState,
  ) {}

  async check(): Promise<HealthResponse> {
    if (!this.readiness.isReady() || !(await this.repository.databaseIsReachable())) {
      throw new ServiceNotReadyError();
    }
    return { status: "ok" };
  }
}
