import {validLogs} from "./logs.validation.ts";
import {insertLog} from "./logs.repository.ts";

export async function insertLogs(logs: unknown) : Promise<void> {
    const result = validLogs(logs);
    if (!result.success) {
        throw new Error(result.error);
    }
    result.valid.forEach(async (log) => {
        await insertLog(log);
    });
}