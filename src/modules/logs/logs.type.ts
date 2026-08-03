export type Attributes = Record<string, string | number | boolean>;
export type Log = {
    timestamp: Date;
    level: "debug" | "info" | "warn" | "error";
    service: string;
    message: string;
    attributes?: Attributes;
};
type RejectedLog = {
  index: number;
  reason: string;
};
export type ValidateLogsResult =
    {
        success: false;
        error: string;
    }
    | 
    {
        success: true;
        valid: Log[];
        rejected: RejectedLog[];
    };
