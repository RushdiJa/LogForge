import { Router } from "express";
import {createLogsController, getLogsController} from "./logs.controller.js"
import { logsErrorHandler } from "./logs.errors.js";

export const logsRouter : Router = Router();
logsRouter.post("/", createLogsController);
logsRouter.get("/",getLogsController);
logsRouter.use(logsErrorHandler);