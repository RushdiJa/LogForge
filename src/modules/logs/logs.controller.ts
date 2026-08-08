import type { NextFunction, Request, Response } from "express";
import {getLogs, getLogsAggregate, insertLogs} from "./logs.service.js";
import {type ValidateLogsResult, LogsError} from "./logs.type.js";
export async function createLogsController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
    try {
        if (!req.is("application/json")) {
            throw new LogsError(
                "UNSUPPORTED_MEDIA_TYPE",
                415,
                "Content-Type must be application/json",
            );
        }

        const result: ValidateLogsResult = await insertLogs(req.body?.logs);
        const accepted = result.valid.length;

        if (accepted === 0) {
            res.status(400).json({
                accepted: 0,
                rejected: result.rejected,
            });
            return;
        }

        res.status(200).json({
            accepted,
            rejected: result.rejected,
        });
    } 
    catch (error: unknown) {
        next(error);
    }
}

export async function getLogsController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await getLogs(req.query);
    res.status(200).json(result);
  } catch (error: unknown) {
    next(error);
  }
}


export async function getLogsAggregateController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await getLogsAggregate(req.query);
    res.status(200).json(result);
  } catch (error: unknown) {
    next(error);
  }
}