import { db } from "../../db/index.js";
import { logs } from "../../db/schema.js";
import { type Log , LogsError} from "./logs.type.js";

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