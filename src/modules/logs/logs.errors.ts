import type { ErrorRequestHandler } from "express";
import { LogsError } from "./logs.type.js";

export const logsErrorHandler: ErrorRequestHandler = (
  error: unknown,
  _req,
  res,
  _next,
): void => {
  if (error instanceof LogsError) {
    res.status(error.statusCode).json({
      error: error.message,
    });

    return;
  }

  console.error("Unexpected logs error:", error);

  res.status(500).json({
    error: "An unexpected error occurred",
  });
};