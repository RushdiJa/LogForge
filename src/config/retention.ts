const DEFAULT_RETENTION_DAYS = 30;

export function getRetentionDays(): number {
  const rawValue = process.env.RETENTION_DAYS;

  if (rawValue === undefined) {
    return DEFAULT_RETENTION_DAYS;
  }

  const retentionDays = Number(rawValue);

  if (
    !Number.isInteger(retentionDays) ||
    retentionDays <= 0
  ) {
    throw new Error(
      "RETENTION_DAYS must be a positive integer",
    );
  }

  return retentionDays;
}