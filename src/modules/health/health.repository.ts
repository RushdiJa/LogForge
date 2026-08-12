import type { Database } from "../../db/client.js";

export class HealthRepository {
  constructor(private readonly sql: Database) {}

  async databaseIsReachable(): Promise<boolean> {
    try {
      await this.sql`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
