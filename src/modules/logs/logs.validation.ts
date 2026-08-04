import {
  logSchema,
  LogsError,
  type RejectedLog,
  type Log,
  type ValidateLogsResult} from "./logs.type.js";

export async function validLogs(logs: unknown): Promise<ValidateLogsResult> {
    if (!Array.isArray(logs)) {
        throw new LogsError(
            "INVALID_REQUEST_BODY", 
            400, 
            "logs must be an array"
        );
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

    return {
        valid,
        rejected,
    };

}
