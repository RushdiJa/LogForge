import type { Log , Attributes, ValidateLogsResult} from "./logs.type.js";

export function validLogs(logs: unknown): ValidateLogsResult {
    console.log("Validating logs: ", logs);
    if (!Array.isArray(logs)) {
        console.log("WTF? logs is not an array: ", logs);
        return {
            success: false,
            error: "Invalid input: logs must be an array"
        };
    }
    const valid: Log[] = [];
    const rejected: { index: number; reason: string }[] = [];
    logs.forEach((log, index) => {
        if (checkLog(log)) {
            log.timestamp = new Date(log.timestamp); 
            // because json give it to us as string, we need to convert it to Date object
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
    if (logObj.timestamp !== undefined && !checkTimestamp(logObj.timestamp)) {
        return false;
    }
    if (logObj.attributes !== undefined && checkAttributes(logObj.attributes) !== true) {
        return false;
    }
    return true;
}

const ISO_8601_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
function checkTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  if (!ISO_8601_TIMESTAMP.test(value)) {
    return false;
  }

  const timestampMs = Date.parse(value);

  if (Number.isNaN(timestampMs)) {
    return false;
  }

  const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;

  return timestampMs <= fiveMinutesFromNow;
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