import type { Log , Attributes, ValidateLogsResult} from "./logs.type.js";

export function validLogs(logs: unknown): ValidateLogsResult {
    if (!Array.isArray(logs)) {
        return {
            success: false,
            error: "Invalid input: logs must be an array"
        };
    }
    const valid: Log[] = [];
    const rejected: { index: number; reason: string }[] = [];
    logs.forEach((log, index) => {
        if (checkLog(log)) {
            valid.push(log);
        } else {
            rejected.push({
                index,
                reason: "Invalid log format" // later will provide more detailed reasons for rejection 
            });
        }
    });
    if(valid.length === 0) {
        return {
            success: false,
            error: "No valid logs found"
        };
    }
    return {
        success: true,
        valid,
        rejected
    };
}
function checkLog(log: unknown): log is Log {
    if (typeof log !== "object") {
        return false;
    }
    const logObj = log as Record<string, unknown>;
    if (typeof logObj.level !== "string" || !["debug", "info", "warn", "error"].includes(logObj.level)) {
        return false;
    }
    if (typeof logObj.service !== "string") {
        return false;
    }
    if (typeof logObj.message !== "string") {
        return false;
    }
    if (logObj.attributes !== undefined && checkAttributes(logObj.attributes) !== true) {
        return false;
    }
    return true;
}

const ALLOWED_ATTRIBUTE_TYPES : string[] = ["string", "number", "boolean"] as const;
function checkAttributes(attributes: unknown): attributes is Attributes {
    if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes) ) {
        return false;
    }
    const attributesObj = attributes as Record<string, unknown>;
    for (const key in attributesObj) {
        const value = attributesObj[key];
        if (!ALLOWED_ATTRIBUTE_TYPES.includes(typeof value)) {
            return false;
        }
    }
    return true;
}