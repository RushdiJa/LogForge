import { Pool } from "pg";

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://logforge:logforge@localhost:5432/logforge",
  max: 2,
});