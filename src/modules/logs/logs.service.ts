import {validLogs} from "./logs.validation.ts";
import {insertLog} from "./logs.repository.ts";
import {type ValidateLogsResult} from "./logs.type.ts";
export async function insertLogs(logs: unknown) : Promise<ValidateLogsResult> {
    console.log("Validating logs: ", logs);
    const result = validLogs(logs);
    
    if (!result.success) {
        throw new Error(result.error);
    }
    result.valid.forEach(async (log) => {
        await insertLog(log);
    });
    return result;
}