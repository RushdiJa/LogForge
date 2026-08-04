import type { ErrorRequestHandler , Request, NextFunction, Response} from "express";
import {LogsError} from "./logs.type.ts";
export const logsErrorHandler: ErrorRequestHandler = (
  error: unknown,
  _req,
  res,
  _next,
): void => {
  if (error instanceof LogsError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
      },
    });
    return;
  }
  console.error("Unexpected logs error:", error);
  res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred",
    },
  });
};