import { db } from "../../db/index.js";
import { logs } from "../../db/schema.ts";
import type { Log } from "./logs.type.ts";

export async function insertLog(log: Log) : Promise<void> {
    console.log("Inserting log: ", log);
    try{
        await db.insert(logs).values(log).execute();
    }
    catch(error : any){
        console.log("Error inserting log: ");
        // throw new Error(error.message ?? "An unknown error occurred while inserting the log");
    }
}