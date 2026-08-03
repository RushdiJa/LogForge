import type { Request, Response } from "express";
import {insertLogs} from "./logs.service.ts"
export async function createLogs(
  req: Request,
  res: Response,
): Promise<void> {
    console.log("Received request to create logs: ", req.body);
    if (!req.is("application/json")) {
        res.status(415).json({
            status: "unsupported_media_type",
            message: "Content-Type must be application/json",
        });
        return;
    }
    try {
        console.log("Inserting logs: ", req.body?.logs);
        await insertLogs(req.body?.logs);
        res.status(201).json({ status: "created", message: "Logs inserted successfully" });
    } catch (error : any) { 
        // we will use route error handler to handle the error and send the response
        res.status(400).json({ status: "bad_request", message: error.message ?? "An unknown error occurred" });
    }
}