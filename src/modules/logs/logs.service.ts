import {validLogs} from "./logs.validation.js";
import {insertLog} from "./logs.repository.js";
import {type ValidateLogsResult} from "./logs.type.js";
export async function insertLogs(logs: unknown) : Promise<ValidateLogsResult> {
    const result : ValidateLogsResult = await validLogs(logs);
    await Promise.all(
        result.valid.map((log) => insertLog(log)),
    );
    return result;
}