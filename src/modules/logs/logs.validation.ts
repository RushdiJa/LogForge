import {
  logSchema,
  type RejectedLog,
  type Log,
  type ValidateLogsResult,
} from "./logs.type.js";

export function validLogs(logs: unknown): ValidateLogsResult {
    if (!Array.isArray(logs)) {
        return {
        success: false,
        error: "Invalid input: logs must be an array",
        };
    }

    const valid: Log[] = [];
    const rejected : RejectedLog[] = []
    logs.forEach((log, index) => {
        const result = logSchema.safeParse(log);

        if (result.success) {
            valid.push(result.data);
        } else {
            rejected.push({
                index: index,
                reason: result.error.issues
                .map((issue) => {
                    const field = issue.path.join(".");

                    return field ? `${field}: ${issue.message}` : issue.message;
                })
                .join("\n"),
            });
        }
    });

    if (valid.length === 0) {
        return {
            success: false,
            error: "No valid logs found",
        };
    }

    return {
        success: true,
        valid,
        rejected,
    };

}
