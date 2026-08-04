import { Router } from "express";
import {createLogs} from "./logs.controller.js"
import { logsErrorHandler } from "./logs.errors.js";

export const logsRouter : Router = Router();
logsRouter.post("/", createLogs);
logsRouter.use(logsErrorHandler);