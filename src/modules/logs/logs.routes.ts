import { Router } from "express";
import {createLogs} from "./logs.controller.ts"
export const logsRouter : Router = Router();
logsRouter.post("/", createLogs);