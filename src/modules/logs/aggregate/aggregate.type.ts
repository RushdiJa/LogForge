import type { LogFilters } from "../logs.type.js";

export const BUCKETS = ["1m", "5m", "1h", "1d"] as const;
export const GROUPS = ["service", "level"] as const;

export type Bucket = (typeof BUCKETS)[number];
export type GroupBy = (typeof GROUPS)[number];

export interface AggregateQuery extends LogFilters {
  since: string;
  until: string;
  bucket: Bucket;
  groupBy?: GroupBy;
}

export interface AggregateBucket {
  start: string;
  group: string | null;
  count: number;
}

export interface AggregateResult {
  buckets: AggregateBucket[];
}
