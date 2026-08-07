import { db } from "../../db/index.js";
import { logs } from "../../db/schema.js";
import { type Log , LogsError, type ParsedLogsFilters} from "./logs.type.js";
import {
  and,
  desc,
  eq,
  gte,
  lt,
  type SQL,
  or,
  ilike,
  sql
  
} from "drizzle-orm";

export type StoredLog = typeof logs.$inferSelect;

export async function insertLog(log: Log) : Promise<void> {
    console.log("Inserting log: ", log);
    try{
        await db.insert(logs).values(log).execute();
    }
    catch(error : unknown){
        console.error("Failed to insert log:", error);
        throw new LogsError(
            "LOGS_DATABASE_ERROR",
            500,
            "Could not insert log",
        );
    }
}

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}
function jsonbTextAttribute(key: string): SQL<string> {
  return sql<string>`jsonb_extract_path_text(${logs.attributes}, ${key})`;
}
export async function queryLogs(
  filters: ParsedLogsFilters,
): Promise<StoredLog[]> {
    const conditions: SQL[] = [];
    if (filters.service !== undefined) {
        conditions.push(
            eq(logs.service, filters.service),
        );
    }
    if (filters.level !== undefined) {
        conditions.push(
            eq(logs.level, filters.level),
        );
    }
    if (filters.since !== undefined) {
        conditions.push(
            gte(logs.timestamp, filters.since),
        );
    }

    if (filters.until !== undefined) {
        conditions.push(
            lt(logs.timestamp, filters.until),
        );
    }
    if (filters.q !== undefined) {
        const escapedQuery = escapeLike(filters.q);

        conditions.push(
            ilike(logs.message, `%${escapedQuery}%`),
        );
    }
    if (filters.cursor !== undefined) {
        conditions.push(
            or(
                lt(logs.timestamp, filters.cursor.timestamp),
                and(
                    eq(logs.timestamp, filters.cursor.timestamp),
                    lt(logs.id, filters.cursor.id),
                ),
            )!,
        );
    }
    if(filters.attributes !== undefined){
        for (const [key, value] of Object.entries(filters.attributes)) {
            conditions.push(
                eq(jsonbTextAttribute(key), value),
            );
        }
    }
    return db
    .select()
    .from(logs)
    .where(
        conditions.length > 0
        ? and(...conditions)
        : undefined,
    )
    .orderBy(
        desc(logs.timestamp),
        desc(logs.id),
    )
    .limit(filters.limit + 1);
}