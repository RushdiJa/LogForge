export function toIsoTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`PostgreSQL returned an invalid timestamp: ${String(value)}`);
  }

  return date.toISOString();
}
