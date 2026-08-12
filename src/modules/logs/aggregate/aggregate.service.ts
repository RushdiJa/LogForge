import type { AggregateRepository } from "./aggregate.repository.js";
import type { AggregateResult } from "./aggregate.type.js";
import { validateAggregateQuery } from "./aggregate.validate.js";

export class AggregateService {
  constructor(private readonly repository: AggregateRepository) {}

  async aggregate(rawQuery: unknown): Promise<AggregateResult> {
    const query = validateAggregateQuery(rawQuery);
    return { buckets: await this.repository.aggregate(query) };
  }
}
