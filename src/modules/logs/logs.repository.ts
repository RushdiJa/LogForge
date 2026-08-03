import { db } from "../../db/index.js";
import { logs } from "../../db/schema.ts";
import type { Log } from "./logs.type.ts";

export async function insertLog(log: Log) : Promise<void> {
    await db.insert(logs).values(log).execute();
}