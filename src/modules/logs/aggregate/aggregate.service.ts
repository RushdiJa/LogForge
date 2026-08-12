import type { QueryCache } from "../../../cache/redis-query-cache.js";
import {
  aggregateCacheIdentity,
  isCacheableAggregateQuery,
  type AggregateRepository,
} from "./aggregate.repository.js";
import type { AggregateResult } from "./aggregate.type.js";
import { validateAggregateQuery } from "./aggregate.validate.js";

export class AggregateService {
  constructor(
    private readonly repository: AggregateRepository,
    private readonly cache?: QueryCache,
  ) {}

  async aggregate(rawQuery: unknown): Promise<AggregateResult> {
    const query = validateAggregateQuery(rawQuery);
    const load = async (): Promise<AggregateResult> => ({
      buckets: await this.repository.aggregate(query),
    });
    if (this.cache === undefined || !isCacheableAggregateQuery(query)) return load();
    return this.cache.getOrLoad("aggregate", aggregateCacheIdentity(query), load);
  }
}
